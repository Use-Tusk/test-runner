import axios from "axios";
import * as core from "@actions/core";
import {
  IActionCommand,
  IActionCommandResult,
  ITestExecutionConfig,
  ITestingSandboxConfigInfo,
} from "./types.js";

const serverUrl = core.getInput("tuskUrl", { required: true }).replace(/\/$/, "");
const authToken = core.getInput("authToken", { required: true });
const timeoutMs = 10_000;

const headers = {
  Authorization: `Bearer ${authToken}`,
  "Content-Type": "application/json",
};

// Send GitHub runner context to the server for every request
// Full list: https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/store-information-in-variables#default-environment-variables
const runnerMetadata = {
  githubRepo: process.env.GITHUB_REPOSITORY,
  githubRef: process.env.GITHUB_REF,
  githubRunId: process.env.GITHUB_RUN_ID, // Workflow run ID. This number does not change if you re-run the workflow run.
  githubSha: process.env.GITHUB_SHA, // Last commit on the GITHUB_REF (branch or tag that received dispatch)
  githubTriggeringActor: process.env.GITHUB_TRIGGERING_ACTOR,
  githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
  githubWorkflowRef: process.env.GITHUB_WORKFLOW_REF,
};

async function withRetry<T>(requestFn: () => Promise<T>, maxRetries = 3): Promise<T> {
  let lastError: Error | null = null;
  const retryableStatusCodes = [500, 502, 503, 504];
  const retryableErrorCodes = ["ECONNABORTED", "ECONNRESET", "EAI_AGAIN"];
  const retryableErrorMessages = ["canceled"];

  for (let attempt = 0; attempt < maxRetries + 1; attempt++) {
    try {
      return await requestFn();
    } catch (error) {
      lastError = error as Error;
      let shouldRetry = false;
      let reason = "";

      // Check for retryable status codes
      if (
        axios.isAxiosError(error) &&
        error.response?.status &&
        retryableStatusCodes.includes(error.response.status)
      ) {
        shouldRetry = true;
        reason = `status code ${error.response.status}`;
      }

      // Check for retryable error codes
      else if (
        axios.isAxiosError(error) &&
        error.code &&
        retryableErrorCodes.includes(error.code)
      ) {
        shouldRetry = true;
        reason = `error code ${error.code}`;
      }

      // Check for retryable error messages (e.g., AbortSignal timeout)
      else if (error instanceof Error && retryableErrorMessages.includes(error.message)) {
        shouldRetry = true;
        reason = `error message "${error.message}"`;
      }

      if (shouldRetry && attempt < maxRetries) {
        const delayMs = 2 ** attempt * 1000; // Exponential backoff: 1s, 2s, 4s
        core.info(
          `[withRetry][${new Date().toISOString()}] Request failed with ${reason}, retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      // For non-retryable errors or if we've exhausted retries, throw the error
      throw error;
    }
  }

  // This line should technically be unreachable due to the loop structure and the final throw
  // But it satisfies TypeScript's need for a return path if the loop somehow completes without returning/throwing
  throw lastError || new Error("Retry mechanism failed unexpectedly.");
}

export const pollCommands = async ({
  runId,
  testingSandboxConfigId,
}: {
  runId: string;
  testingSandboxConfigId?: string;
}): Promise<IActionCommand[]> => {
  try {
    const response = await axios.get(`${serverUrl}/poll-commands`, {
      params: {
        runId,
        testingSandboxConfigId,
        runnerMetadata,
      },
      signal: AbortSignal.timeout(timeoutMs),
      headers,
    });

    return response.data.commands as IActionCommand[];
  } catch (error) {
    core.info(`[pollCommands][${new Date().toISOString()}] Error polling commands: ${error}`);

    throw error;
  }
};

export const ackCommand = async ({ runId, commandId }: { runId: string; commandId: string }) => {
  return withRetry(async () => {
    const response = await axios.post(
      `${serverUrl}/ack-command`,
      {
        runId,
        commandId,
        runnerMetadata,
      },
      {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      },
    );

    if (response.status === 200) {
      core.info(
        `[ackCommand][${new Date().toISOString()}] Successfully acked command ${commandId}`,
      );
    } else {
      core.warning(
        `[ackCommand][${new Date().toISOString()}] Failed to ack command ${commandId}, server is probably not running`,
      );
    }
  });
};

export const sendCommandResult = async ({
  runId,
  result,
}: {
  runId: string;
  result: IActionCommandResult;
}): Promise<void> => {
  return withRetry(async () => {
    const response = await axios.post(
      `${serverUrl}/command-result`,
      {
        runId,
        result,
        runnerMetadata,
      },
      {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      },
    );

    if (response.status === 200) {
      core.info(
        `[sendCommandResult][${new Date().toISOString()}] Successfully sent result for command ${result.id}`,
      );
    } else {
      core.warning(
        `[sendCommandResult][${new Date().toISOString()}] Failed to send result for command ${result.id}, server is probably not running. Server response: ${response.data}`,
      );
    }
  });
};

export const getTestingSandboxConfigInfo = async ({
  runId,
}: {
  runId: string;
}): Promise<ITestingSandboxConfigInfo | null> => {
  return withRetry(async () => {
    const response = await axios.get(`${serverUrl}/test-execution-config`, {
      params: {
        runId,
        runnerMetadata,
      },
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.status === 200) {
      core.info(
        `[getTestExecutionConfig][${new Date().toISOString()}] Successfully fetched test execution config`,
      );

      const testExecutionConfig = response.data.testExecutionConfig as ITestExecutionConfig;
      const testingSandboxConfigId = response.data.testingSandboxConfigId;
      return { testingSandboxConfigId, testExecutionConfig };
    } else {
      core.warning(
        `[getTestExecutionConfig][${new Date().toISOString()}] Failed to fetch test execution config. Server response: ${response.data}`,
      );

      return null;
    }
  });
};
