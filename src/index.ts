import * as core from "@actions/core";
import { CommandType, IActionCommand, RunnerAction, ScriptData } from "./types.js";
import { processCommands } from "./handleCommands.js";
import { ackCommand, pollCommands } from "./requests.js";
import { limiter, testingSandboxConfigId } from "./limiter.js";

async function run() {
  core.info("Starting runner...");

  try {
    const runId = core.getInput("runId", { required: true });
    core.info(`Run ID: ${runId}`);

    const commitSha = core.getInput("commitSha", { required: true });
    core.info(`Commit SHA: ${commitSha}`);

    const testScript = core.getInput("testScript", { required: true });
    const lintScript = core.getInput("lintScript", { required: false }) || undefined;
    const coverageScript = core.getInput("coverageScript", { required: false }) || undefined;
    const scripts: ScriptData = {
      test: testScript,
      lint: lintScript,
      coverage: coverageScript,
    };

    const pollingDuration = parseInt(core.getInput("pollingDuration") || "3600", 10); // Default 60 minutes
    const pollingInterval = parseInt(core.getInput("pollingInterval") || "5", 10); // Default 5 seconds
    const inactivityTimeoutSeconds = 20 * 60; // 20 minutes

    // Start polling for commands
    const startTime = Date.now();
    const endTime = startTime + pollingDuration * 1000;
    let lastCommandReceivedTime = startTime;

    // Counter for consecutive polling errors
    const MAX_CONSECUTIVE_ERRORS = 5;
    let consecutiveErrorCount = 0;

    const pendingAckCommands: Map<string, IActionCommand> = new Map();
    const commandsSentToProcess = new Set<string>();

    while (Date.now() < endTime) {
      // Check for inactivity timeout
      if (Date.now() - lastCommandReceivedTime > inactivityTimeoutSeconds * 1000) {
        core.info(
          `[${new Date().toISOString()}] No commands received for ${inactivityTimeoutSeconds} seconds. Exiting polling loop.`,
        );
        break;
      }

      try {
        core.info(
          `[${new Date().toISOString()}] Polling server for commands (${Math.round((endTime - Date.now()) / 1000)}s remaining)...`,
        );

        core.info(`Current command queue stats: ${JSON.stringify(limiter.counts())}`);

        const polledCommands = await pollCommands({ runId, testingSandboxConfigId });

        consecutiveErrorCount = 0;

        if (polledCommands.length > 0) {
          core.info(`Received ${polledCommands.length} commands from server`);
          lastCommandReceivedTime = Date.now();

          for (const polledCmd of polledCommands) {
            // If not acked yet and not already sent for processing, add to pendingAckCommands
            if (!pendingAckCommands.has(polledCmd.id) && !commandsSentToProcess.has(polledCmd.id)) {
              pendingAckCommands.set(polledCmd.id, polledCmd);
              core.info(`New command ${polledCmd.id} added to pending acknowledgment queue.`);
            } else if (pendingAckCommands.has(polledCmd.id)) {
              // Already pending ack, will attempt ack again
              core.info(
                `Command ${polledCmd.id} re-polled, already pending acknowledgment. Will attempt ack again.`,
              );
            } else {
              // Already in commandsSentToProcess
              core.info(
                `Command ${polledCmd.id} re-polled, but was already sent for processing. Ignoring.`,
              );
            }
          }
        }

        const commandsToAttemptAck = Array.from(pendingAckCommands.values());

        if (commandsToAttemptAck.length > 0) {
          core.info(`Attempting to acknowledge ${commandsToAttemptAck.length} command(s).`);

          // The promises from this .map() will always fulfill with an object describing the ack outcome.
          const ackOperationPromises = commandsToAttemptAck.map(async (cmdToAck) => {
            try {
              await ackCommand({ runId, commandId: cmdToAck.id });
              return { success: true as const, command: cmdToAck, error: undefined };
            } catch (error) {
              core.warning(
                `Failed to acknowledge command ${cmdToAck.id}: ${error}. It will remain in the pending queue.`,
              );
              return { success: false as const, command: cmdToAck, error };
            }
          });

          const ackPromiseSettledResults = await Promise.allSettled(ackOperationPromises);

          const successfullyAckedCommands: IActionCommand[] = [];
          ackPromiseSettledResults.forEach((settledResult, index) => {
            const originalCommand = commandsToAttemptAck[index];

            if (settledResult.status === "fulfilled") {
              const ackOutcome = settledResult.value;
              const command = ackOutcome.command;

              if (ackOutcome.success) {
                pendingAckCommands.delete(command.id);
                core.info(`Command ${command.id} acknowledged and removed from pending queue.`);

                if (commandsSentToProcess.has(command.id)) {
                  core.info(
                    `Command ${command.id} was acknowledged but already marked as sent to process. Won't re-process.`,
                  );
                } else {
                  successfullyAckedCommands.push(command);
                }
              } else {
                // Ack failed, command remains in pendingAckCommands.
                core.info(
                  `Ack for command ${command.id} failed (error: ${ackOutcome.error}), it remains in pending queue.`,
                );
              }
            } else {
              // This 'else' branch (settledResult.status === "rejected") should be highly unlikely,
              // as the promises from ackOperationPromises are designed to always fulfill.
              // This would indicate an unexpected error within the .map() callback itself, outside its try/catch.
              core.error(
                `Unexpected error during ack processing for command ${originalCommand.id}: ${settledResult.reason}. Command remains in pending queue.`,
              );
            }
          });

          if (successfullyAckedCommands.length > 0) {
            core.info(`Successfully acknowledged ${successfullyAckedCommands.length} command(s).`);
            successfullyAckedCommands.forEach((cmd) => {
              core.info(`Command to be processed:\n${JSON.stringify(cmd, null, 2)}`);
            });

            const terminateCommand = successfullyAckedCommands.find(
              (cmd) =>
                cmd.command.type === CommandType.RUNNER &&
                cmd.command.action === RunnerAction.TERMINATE,
            );

            if (terminateCommand) {
              core.info(
                `Terminate command ${terminateCommand.id} received and acknowledged. Exiting...`,
              );
              commandsSentToProcess.add(terminateCommand.id);
              // any other successfullyAckedCommands in this batch won't be processed due to break. This is intended for TERMINATE.
              break;
            }

            const commandsForProcessingThisCycle: IActionCommand[] = [];
            for (const cmd of successfullyAckedCommands) {
              commandsSentToProcess.add(cmd.id);
              commandsForProcessingThisCycle.push(cmd);
            }

            if (commandsForProcessingThisCycle.length > 0) {
              core.info(
                `Dispatching ${commandsForProcessingThisCycle.length} commands for background processing.`,
              );

              // Start processing in the background
              processCommands({
                commands: commandsForProcessingThisCycle,
                runId,
                scripts,
              }).catch((error) => {
                core.error(
                  `Unexpected error during background command processing orchestrator: ${error}`,
                );
              });
            }
          }
        } else if (polledCommands.length === 0 && pendingAckCommands.size === 0) {
          core.debug("No commands received and no commands pending acknowledgment.");
        }
      } catch (error) {
        // If this is just a timeout, it's expected behavior
        if (error instanceof Error && error.message.includes("ECONNABORTED")) {
          core.debug("Polling timeout (expected)");
        } else {
          consecutiveErrorCount++;
          core.warning(
            `Polling error: ${error} (consecutive errors: ${consecutiveErrorCount}/${MAX_CONSECUTIVE_ERRORS})`,
          );

          const detailedError = error as any;

          if (detailedError.code) {
            core.warning(`Error code: ${detailedError.code}`);
          }

          if (error instanceof Error && error.stack) {
            core.warning(`Stack trace: ${error.stack}`);
          }

          if (detailedError.response && detailedError.response.status === 401) {
            core.setFailed(
              `Error: ${detailedError.response.data.error}. Verify that authToken is valid. Exiting...`,
            );
            process.exit(1);
          }

          if (consecutiveErrorCount >= MAX_CONSECUTIVE_ERRORS) {
            core.setFailed("Max consecutive polling errors reached, exiting...");
            process.exit(1);
          }

          // Wait before retrying to avoid hammering the server
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      }

      await new Promise((resolve) => setTimeout(resolve, pollingInterval * 1000));
    }

    core.info("Long-polling completed successfully");

    process.exit(0);
  } catch (error) {
    core.setFailed(`Action failed`);
    core.error(`Server response body: ${JSON.stringify(error)}`);
  }
}

run();
