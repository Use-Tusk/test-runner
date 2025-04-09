import axios from "axios";
import * as core from "@actions/core";
import { IActionCommand, IActionCommandResult } from "./types.js";

const serverUrl = core.getInput("tuskUrl", { required: true }).replace(/\/$/, "");
const authToken = core.getInput("authToken", { required: true });
const timeoutMs = 5_000;

const headers = {
  Authorization: `Bearer ${authToken}`,
  "Content-Type": "application/json",
};

async function withRetry<T>(requestFn: () => Promise<T>, maxRetries = 3): Promise<T> {
  let lastError: Error | null = null;
  const retryableStatusCodes = [500, 502, 503, 504];

  for (let attempt = 0; attempt < maxRetries + 1; attempt++) {
    try {
      return await requestFn();
    } catch (error) {
      lastError = error as Error;

      // Check if it's a 503 error that we should retry
      if (
        axios.isAxiosError(error) &&
        error.response?.status &&
        retryableStatusCodes.includes(error.response.status)
      ) {
        if (attempt < maxRetries) {
          const delayMs = 2 ** attempt * 1000; // Exponential backoff: 1s, 2s, 4s
          core.info(
            `[pollCommands][${new Date().toISOString()}] Received 503 error, retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`,
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
      }

      // For non-retryable errors or if we've exhausted retries, throw the error
      throw error;
    }
  }

  // This should never happen, but TypeScript needs it
  throw lastError;
}

export const pollCommands = async ({
  runId,
  runnerMetadata,
}: {
  runId: string;
  runnerMetadata: Record<string, string | undefined>;
}): Promise<IActionCommand[]> => {
  const response = await axios.get(`${serverUrl}/poll-commands`, {
    params: {
      runId,
      runnerMetadata,
    },
    timeout: timeoutMs,
    signal: AbortSignal.timeout(5_000),
    headers,
  });

  return response.data.commands as IActionCommand[];
};

export const ackCommand = async ({ runId, commandId }: { runId: string; commandId: string }) => {
  return withRetry(async () => {
    const response = await axios.post(
      `${serverUrl}/ack-command`,
      {
        runId,
        commandId,
      },
      {
        headers,
        timeout: timeoutMs,
        signal: AbortSignal.timeout(5_000),
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
      },
      {
        headers,
        timeout: timeoutMs,
        signal: AbortSignal.timeout(5_000),
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
