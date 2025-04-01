import * as core from "@actions/core";
import { FileCommand, RunnerAction, ScriptData } from "./types.js";
import { processCommand } from "./handleCommands.js";
import { ackCommand, pollCommands } from "./requests.js";

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

    const pollingDuration = parseInt(core.getInput("pollingDuration") || "1800", 10); // Default 30 minutes
    const pollingInterval = parseInt(core.getInput("pollingInterval") || "5", 10); // Default 5 seconds

    // Get GitHub context
    // Full list: https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/store-information-in-variables#default-environment-variables
    const runnerMetadata = {
      githubRepo: process.env.GITHUB_REPOSITORY,
      githubRef: process.env.GITHUB_REF,
      commitSha,
    };

    // Start polling for commands
    const startTime = Date.now();
    const endTime = startTime + pollingDuration * 1000;

    // Counter for consecutive polling errors
    const MAX_CONSECUTIVE_ERRORS = 5;
    let consecutiveErrorCount = 0;

    while (Date.now() < endTime) {
      try {
        core.info(
          `Polling server for commands (${Math.round((endTime - Date.now()) / 1000)}s remaining)...`,
        );

        const commands = await pollCommands({
          runId,
          runnerMetadata,
        });

        consecutiveErrorCount = 0;

        if (commands.length > 0) {
          core.info(`Received ${commands.length} commands from server`);

          commands.forEach((cmd) => {
            core.info(`Command:\n${JSON.stringify(cmd, null, 2)}`);
          });

          if (
            commands.some(
              (cmd) => cmd.type == "runner" && cmd.actions.includes(RunnerAction.TERMINATE),
            )
          ) {
            await ackCommand({
              runId,
              commandId: commands.find(
                (cmd) => cmd.type == "runner" && cmd.actions.includes(RunnerAction.TERMINATE),
              )!.id,
            });

            core.info("Terminate command received, exiting...");
            break;
          }

          const fileCommands = commands.filter((cmd) => cmd.type == "file") as FileCommand[];

          // Not awaiting here to avoid blocking the main thread
          Promise.all(
            fileCommands.map((command) => processCommand({ runId, command, scripts })),
          ).catch((error) => {
            core.warning(`Error in command batch processing: ${error}`);
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

          if (consecutiveErrorCount >= MAX_CONSECUTIVE_ERRORS) {
            core.setFailed("Max consecutive polling errors reached, exiting...");
            break;
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
