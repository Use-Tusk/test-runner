import * as core from "@actions/core";
import Bottleneck from "bottleneck";

// TODO: Also fetch maxConcurrency from test execution config

const maxConcurrency = parseInt(core.getInput("maxConcurrency") || "5", 10);

const limiter = new Bottleneck({
  maxConcurrent: maxConcurrency,
  trackDoneStatus: true,
});

async function getLimiterStats(limiter: Bottleneck) {
  return {
    counts: limiter.counts(),
  };
}

export { limiter, maxConcurrency, getLimiterStats };
