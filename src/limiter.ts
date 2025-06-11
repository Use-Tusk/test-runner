import * as core from "@actions/core";
import Bottleneck from "bottleneck";
import { getTestingSandboxConfigInfo } from "./requests.js";

core.info("Starting limiter setup...");

const runId = core.getInput("runId", { required: true });

let serverConfigMaxConcurrency: number | undefined = undefined;
let testingSandboxConfigId: string | undefined = undefined;

try {
  const testingSandboxConfigInfo = await getTestingSandboxConfigInfo({ runId });
  serverConfigMaxConcurrency = testingSandboxConfigInfo?.testExecutionConfig.maxConcurrency;
  testingSandboxConfigId = testingSandboxConfigInfo?.testingSandboxConfigId;
} catch (error) {
  core.warning(`Failed to fetch testing sandbox config info: ${error}`);
}

if (testingSandboxConfigId) {
  core.info(`Using testing sandbox config ID: ${testingSandboxConfigId}`);
} else {
  core.info("No testing sandbox config ID found.");
}

const stepInputMaxConcurrencyStr = core.getInput("maxConcurrency");

const DEFAULT_MAX_CONCURRENCY = 5;

let maxConcurrency: number;
let source: string;

if (stepInputMaxConcurrencyStr) {
  const parsedInput = parseInt(stepInputMaxConcurrencyStr, 10);
  if (!isNaN(parsedInput) && parsedInput > 0) {
    maxConcurrency = parsedInput;
    source = "step input 'maxConcurrency'";
  } else {
    // Invalid step input, fall through to check server config or default
    core.warning(
      `Invalid value provided for 'maxConcurrency' input: "${stepInputMaxConcurrencyStr}". Ignoring step input.`,
    );
    if (serverConfigMaxConcurrency && serverConfigMaxConcurrency > 0) {
      maxConcurrency = serverConfigMaxConcurrency;
      source = "server config";
    } else {
      maxConcurrency = DEFAULT_MAX_CONCURRENCY;
      source = "default (invalid step input)";
    }
  }
} else if (serverConfigMaxConcurrency && serverConfigMaxConcurrency > 0) {
  // Step input not provided, use server config if available
  maxConcurrency = serverConfigMaxConcurrency;
  source = "server config";
} else {
  // Neither step input nor server config provided/valid, use default
  maxConcurrency = DEFAULT_MAX_CONCURRENCY;
  source = "default";
}

core.info(`Using max concurrency: ${maxConcurrency} (source: ${source})`);

const limiter = new Bottleneck({
  maxConcurrent: maxConcurrency,
  trackDoneStatus: true,
});

export { limiter, maxConcurrency, testingSandboxConfigId };
