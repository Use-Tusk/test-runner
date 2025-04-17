import * as core from "@actions/core";
import Bottleneck from "bottleneck";
import { getTestExecutionConfig } from "./requests.js";

const runId = core.getInput("runId", { required: true });
const serverTestExecutionConfig = await getTestExecutionConfig({ runId });
const serverConfigMaxConcurrency = serverTestExecutionConfig?.maxConcurrency;
const stepInputMaxConcurrencyStr = core.getInput("maxConcurrency");

const DEFAULT_MAX_CONCURRENCY = 5;

let maxConcurrency: number;
let source: string;

if (serverConfigMaxConcurrency && serverConfigMaxConcurrency > 0) {
  maxConcurrency = serverConfigMaxConcurrency;
  source = "server config";
} else if (stepInputMaxConcurrencyStr) {
  const parsedInput = parseInt(stepInputMaxConcurrencyStr, 10);
  if (!isNaN(parsedInput) && parsedInput > 0) {
    maxConcurrency = parsedInput;
    source = "step input 'maxConcurrency'";
  } else {
    maxConcurrency = DEFAULT_MAX_CONCURRENCY;
    source = "default (invalid step input)";
    core.warning(
      `Invalid value provided for 'maxConcurrency' input: "${stepInputMaxConcurrencyStr}". Using default value: ${maxConcurrency}`,
    );
  }
} else {
  maxConcurrency = DEFAULT_MAX_CONCURRENCY;
  source = "default";
}

core.info(`Using max concurrency: ${maxConcurrency} (source: ${source})`);

const limiter = new Bottleneck({
  maxConcurrent: maxConcurrency,
  trackDoneStatus: true,
});

export { limiter, maxConcurrency };
