import axios from "axios";
import * as core from "@actions/core";
import { Command, FileCommandResult } from "./types.js";

const serverUrl = core.getInput("tuskUrl", { required: true });
const authToken = core.getInput("authToken", { required: true });
const timeoutMs = 5_000;

const headers = {
  Authorization: `Bearer ${authToken}`,
  "Content-Type": "application/json",
};

async function withRetry<T>(requestFn: () => Promise<T>, maxRetries = 3): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries + 1; attempt++) {
    try {
      return await requestFn();
    } catch (error) {
      lastError = error as Error;

      // Check if it's a 503 error that we should retry
      if (axios.isAxiosError(error) && error.response?.status === 503) {
        if (attempt < maxRetries) {
          const delayMs = 2 ** attempt * 1000; // Exponential backoff: 1s, 2s, 4s
          core.info(
            `Received 503 error, retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`,
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
      }

      // For non-503 errors or if we've exhausted retries, throw the error
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
}): Promise<Command[]> => {
  const response = await axios.get(`${serverUrl}/poll-commands`, {
    params: {
      runId,
      runnerMetadata,
    },
    timeout: timeoutMs,
    signal: AbortSignal.timeout(5_000),
    headers,
  });

  return response.data.commands as Command[];
};

export const ackCommand = async ({
  runId,
  commandId,
}: {
  runId: string;
  commandId: string;
}): Promise<Command> => {
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

    if (response.status !== 200) {
      core.warning(`Failed to ack command ${commandId}, server is probably not running`);
    }

    return response.data as Command;
  });
};

export const sendCommandResult = async ({
  runId,
  result,
}: {
  runId: string;
  result: FileCommandResult;
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

    if (response.status !== 200) {
      core.warning(
        `Failed to send result for command ${result.commandId}, server is probably not running`,
      );
    }
  });
};
