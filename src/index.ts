import * as core from "@actions/core";
import { CommandType, RunnerAction, ScriptData } from "./types.js";
import { processCommands } from "./handleCommands.js";
import { ackCommand, pollCommands } from "./requests.js";
import { limiter } from "./limiter.js";

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

        const commands = await pollCommands({ runId });

        consecutiveErrorCount = 0;

        if (commands.length > 0) {
          core.info(`Received ${commands.length} commands from server`);
          lastCommandReceivedTime = Date.now();

          const ackPromises = commands.map(async (cmd) => {
            await ackCommand({ runId, commandId: cmd.id });
          });
          await Promise.allSettled(ackPromises);

          commands.forEach((cmd) => {
            core.info(`Command:\n${JSON.stringify(cmd, null, 2)}`);
          });

          const terminateCommand = commands.find(
            (cmd) =>
              cmd.command.type === CommandType.RUNNER &&
              cmd.command.action === RunnerAction.TERMINATE,
          );

          if (terminateCommand) {
            core.info(
              `Terminate command ${terminateCommand.id} received and acknowledged, exiting...`,
            );
            break;
          }

          // Start processing in the background, do not await here to keep polling loop active
          processCommands({
            commands,
            runId,
            scripts,
          }).catch((error) => {
            // Catch unexpected errors from the processCommandsWithConcurrency orchestrator itself
            core.error(
              `Unexpected error during background command processing orchestrator: ${error}`,
            );
          });
        } else {
          core.debug("No commands received");
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

          const axiosError = error as any;
          if (axiosError.response && axiosError.response.status === 401) {
            core.setFailed(
              `Error: ${axiosError.response.data.error}. Verify that authToken is valid. Exiting...`,
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
