import * as core from "@actions/core";
import {
  FileAction,
  AbsolutePathData,
  ScriptData,
  IActionCommand,
  IFileCommandData,
  IActionCommandResult,
  CommandType,
  IFileCommandResult,
  IBaseFileCommandResult,
  IReadFileCommandResult,
  RunnerAction,
  IRunnerCommandData,
  IScriptRunnerCommandResult,
} from "./types.js";
import { exec } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import Handlebars from "handlebars";
import { sendCommandResult } from "./requests.js";
import { ActionError } from "./errors.js";
import { limiter, maxConcurrency } from "./limiter.js";

let totalErrorCount = 0;

async function processRunnerCommand({
  command,
  runId,
}: {
  command: IActionCommand;
  runId: string;
}): Promise<void> {
  const {
    id: commandId,
    command: { data: commandData, action: commandAction },
  } = command;

  const data = commandData as IRunnerCommandData;
  const action = commandAction as RunnerAction;

  let result: IScriptRunnerCommandResult = {
    stdout: "",
    stderr: "",
    error: "Unknown error occurred",
    exitCode: 1,
    type: CommandType.RUNNER,
    completedAt: Date.now(),
  };

  switch (action) {
    case RunnerAction.SCRIPT:
      core.info("Script command received, executing...");
      if (!data.script) {
        throw new ActionError(
          "Script is missing or invalid. Ensure that a valid script is provided in your workflow.",
        );
      }
      result = (await executeScript({
        script: data.script,
        cwd: process.cwd(),
        commandName: "Script",
        commandType: CommandType.RUNNER,
      })) as IScriptRunnerCommandResult;
      break;
  }

  await sendCommandResult({
    runId,
    result: {
      id: commandId,
      result,
    },
  });
}

export async function processCommands({
  commands,
  runId,
  scripts,
}: {
  commands: IActionCommand[];
  runId: string;
  scripts: ScriptData;
}): Promise<void> {
  core.info(
    `Processing ${commands.length} commands in background with concurrency limit ${maxConcurrency}...`,
  );

  let preSchedulingErrors = 0;
  let schedulingErrors = 0;

  const commandPromises = commands.map((command) => {
    let processFn: () => Promise<void | { error: boolean; commandId: string; reason: string }>;

    if (command.command.type === CommandType.FILE) {
      processFn = () => processFileCommand({ runId, command, scripts });
    } else if (command.command.type === CommandType.RUNNER) {
      processFn = () => processRunnerCommand({ runId, command });
    } else {
      core.error(`Unknown command type for command ${command.id}: ${JSON.stringify(command)}`);
      preSchedulingErrors++;
      totalErrorCount++;
      // Immediately resolve with an error for unknown types, don't schedule
      return Promise.resolve({
        error: true,
        commandId: command.id,
        reason: `Unknown command type: ${JSON.stringify(command)}`,
      });
    }

    return limiter.schedule(processFn).catch((error) => {
      // This catch handles errors during the actual execution of processFn
      core.warning(
        `Error executing command ${command.id} (type: ${command.command.type}): ${error instanceof Error ? error.message : String(error)}`,
      );
      totalErrorCount++;
      return { error: true, commandId: command.id, reason: String(error) };
    });
  });

  const results = await Promise.allSettled(commandPromises);

  // Check results for any additional issues during scheduling/setup phase - should be rare
  // (e.g., if the .catch handler itself failed, or limiter.schedule rejected unexpectedly)
  const schedulingIssues = results.filter((r) => r.status === "rejected").length;

  if (schedulingIssues > 0) {
    core.warning(
      `Encountered ${schedulingIssues} unexpected issues during command scheduling/setup.`,
    );
    schedulingErrors += schedulingIssues;
    totalErrorCount += schedulingIssues;
  }

  core.info(
    `Finished scheduling ${commands.length} commands. Pre-scheduling errors: ${preSchedulingErrors}. Scheduling errors: ${schedulingErrors}. Current total errors: ${totalErrorCount}`,
  );
}

export async function processFileCommand({
  command,
  runId,
  scripts,
}: {
  command: IActionCommand;
  runId: string;
  scripts: ScriptData;
}): Promise<void> {
  const {
    id: commandId,
    command: { data: commandData, action: commandAction },
  } = command;

  // Filtered for file command type before passing into the function
  const data = commandData as IFileCommandData;
  const action = commandAction as FileAction;

  const { filePath: fullFilePath } = setupPaths(data);

  // Ensure directory exists
  await fs.mkdir(path.dirname(fullFilePath), { recursive: true });

  let result: IFileCommandResult = {
    stdout: "",
    error: "Unknown error occurred",
    stderr: "",
    exitCode: 1,
    type: CommandType.FILE,
    completedAt: Date.now(),
    fileContents: "",
  };

  try {
    switch (action) {
      case FileAction.WRITE:
        result = await handleWriteAction(data);
        break;
      case FileAction.READ:
        result = await handleReadAction(data);
        break;
      case FileAction.LINT:
        result = await handleLintAction(scripts, data);
        break;
      case FileAction.LINT_READ:
        result = await handleLintReadAction(scripts, data);
        break;
      case FileAction.WRITE_LINT_READ:
        result = await handleWriteLintReadAction(scripts, data);
        break;
      case FileAction.TEST:
        result = await handleTestAction(scripts, data);
        break;
      case FileAction.COVERAGE:
        result = await handleCoverageAction(scripts, data);
        break;
      case FileAction.DELETE:
        result = await handleDeleteAction(data);
        break;
    }
  } catch (error) {
    core.warning(`Error processing command: ${error}`);
    result = {
      exitCode: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      error: error instanceof Error ? error.message : String(error),
      type: CommandType.FILE,
      completedAt: Date.now(),
    };
  }

  const commandResult: IActionCommandResult = {
    id: commandId,
    result: {
      type: CommandType.FILE,
      completedAt: Date.now(),
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      error: result.exitCode !== 0 ? result.error : undefined,
      fileContents:
        "fileContents" in result ? (result as IReadFileCommandResult).fileContents : undefined,
    },
  };

  core.info(`
[result]
${JSON.stringify(commandResult, null, 2)}
`);

  await sendCommandResult({ runId, result: commandResult });
}

function setupPaths(data: IFileCommandData): AbsolutePathData {
  const repoRoot = process.env.GITHUB_WORKSPACE || process.cwd();
  const baseDir = data.appDir ? path.join(repoRoot, data.appDir) : repoRoot;

  // Normalize file paths to avoid duplication with appDir
  const filePath = normalizeFilePath({ filePath: data.filePath, appDir: data.appDir });
  const originalFilePath = data.originalFilePath
    ? normalizeFilePath({ filePath: data.originalFilePath, appDir: data.appDir })
    : undefined;

  // Create full paths
  const fullFilePath = path.join(baseDir, filePath);
  const fullOriginalFilePath = originalFilePath ? path.join(baseDir, originalFilePath) : undefined;

  core.info(`
[paths]
repoRoot: ${repoRoot}
appDir: ${data.appDir}
baseDir: ${baseDir}
filePath: ${filePath}
originalFilePath: ${originalFilePath}
fullFilePath: ${fullFilePath}
fullOriginalFilePath: ${fullOriginalFilePath}
`);

  return { baseDir, filePath: fullFilePath, originalFilePath: fullOriginalFilePath };
}

function normalizeFilePath({ filePath, appDir }: { filePath: string; appDir?: string }): string {
  if (appDir && filePath.startsWith(appDir + "/")) {
    return filePath.substring(appDir.length + 1);
  }
  return filePath;
}

async function handleWriteAction(data: IFileCommandData): Promise<IBaseFileCommandResult> {
  const { filePath: fullFilePath } = setupPaths(data);

  if (!data.fileContents) {
    throw new ActionError(
      `Failed to write to file (${fullFilePath}). File contents are required for write action.`,
    );
  }

  await fs.writeFile(fullFilePath, data.fileContents, { encoding: "utf8" });
  core.info(`
[write]
File written to ${fullFilePath}
`);

  return { stdout: "", stderr: "", exitCode: 0, type: CommandType.FILE, completedAt: Date.now() };
}

async function handleReadAction(data: IFileCommandData): Promise<IReadFileCommandResult> {
  const { filePath: fullFilePath } = setupPaths(data);

  const fileContents = await fs.readFile(fullFilePath, { encoding: "utf8" });
  core.info(`
[read]
File: ${fullFilePath}
Contents;
${fileContents}
`);
  return {
    fileContents,
    stdout: "",
    stderr: "",
    exitCode: 0,
    type: CommandType.FILE,
    completedAt: Date.now(),
  };
}

const LINT_SCRIPT_MISSING_MESSAGE = "Lint script missing or invalid, skipping lint action.";

async function handleLintAction(
  scripts: ScriptData,
  data: IFileCommandData,
  skipIfMissingLintScript = true,
): Promise<IBaseFileCommandResult> {
  const { baseDir, filePath: fullFilePath } = setupPaths(data);

  if (!scripts.lint && !skipIfMissingLintScript) {
    throw new ActionError(
      "Lint script is missing or invalid. Ensure that a valid lint script is provided in your workflow.",
    );
  } else if (!scripts.lint) {
    core.warning("Lint script is missing. Skipping lint action.");
    return {
      stdout: "",
      stderr: LINT_SCRIPT_MISSING_MESSAGE,
      exitCode: 0,
      type: CommandType.FILE,
      completedAt: Date.now(),
    };
  }

  const lintScript = scripts.lint;

  core.info(`
[lint]
File: ${fullFilePath}
`);
  const lintTemplate = Handlebars.compile(lintScript);
  const relativeFilePath = path.relative(baseDir, fullFilePath);
  const processedLintScript = lintTemplate({
    file: relativeFilePath,
  });

  return (await executeScript({
    script: processedLintScript,
    cwd: baseDir,
    commandName: "Lint",
    commandType: CommandType.FILE,
  })) as IBaseFileCommandResult;
}

async function handleLintReadAction(
  scripts: ScriptData,
  data: IFileCommandData,
): Promise<IReadFileCommandResult> {
  const lintResult = await handleLintAction(scripts, data);

  if (lintResult.exitCode !== 0) {
    return {
      ...lintResult,
      fileContents: "",
    };
  }

  if (lintResult.stderr === LINT_SCRIPT_MISSING_MESSAGE) {
    return {
      ...lintResult,
      fileContents: "",
    };
  }

  const { fileContents } = await handleReadAction(data);

  // Use the lint command's results
  return {
    ...lintResult,
    fileContents,
  };
}

async function handleWriteLintReadAction(
  scripts: ScriptData,
  data: IFileCommandData,
): Promise<IReadFileCommandResult> {
  const writeResult = await handleWriteAction(data);

  if (writeResult.exitCode !== 0) {
    return {
      ...writeResult,
      fileContents: "",
    };
  }

  const readResult = await handleLintReadAction(scripts, data);
  return readResult;
}

async function handleTestAction(
  scripts: ScriptData,
  data: IFileCommandData,
): Promise<IBaseFileCommandResult> {
  const {
    baseDir,
    filePath: fullFilePath,
    originalFilePath: fullOriginalFilePath,
  } = setupPaths(data);
  const testScript = scripts.test;

  if (!testScript || testScript === "") {
    throw new ActionError(
      "Test script is missing or invalid. Ensure that a valid test script is provided in your workflow.",
    );
  }

  // Get relative paths for test command
  let testFilePath = path.relative(baseDir, fullFilePath);
  let origFilePath = fullOriginalFilePath
    ? path.relative(baseDir, fullOriginalFilePath)
    : undefined;

  // Ensure paths don't incorrectly include appDir again
  if (data.appDir) {
    if (testFilePath.startsWith(data.appDir + "/")) {
      testFilePath = testFilePath.substring(data.appDir.length + 1);
    }

    if (origFilePath?.startsWith(data.appDir + "/")) {
      origFilePath = origFilePath.substring(data.appDir.length + 1);
    }
  }

  const testTemplate = Handlebars.compile(testScript);
  const processedTestScript = testTemplate({
    file: testFilePath,
    originalFile: origFilePath,
  });

  core.info(`
[test-execute]
Running script: ${processedTestScript}
Working directory: ${baseDir}
Test file path: ${testFilePath}
Original file path: ${origFilePath}
`);

  const result = (await executeScript({
    script: processedTestScript,
    cwd: baseDir,
    commandName: "Test",
    commandType: CommandType.FILE,
  })) as IBaseFileCommandResult;

  core.info(`
[test-result]
File: ${fullFilePath}
Result:
${result.stdout}
`);

  return result;
}

async function handleCoverageAction(
  scripts: ScriptData,
  data: IFileCommandData,
): Promise<IBaseFileCommandResult> {
  if (!scripts.coverage) {
    throw new ActionError(
      "Coverage script is missing or invalid. Ensure that a valid coverage script is provided in your workflow.",
    );
  }

  const { baseDir } = setupPaths(data);
  const coverageScript = scripts.coverage;

  core.info(`
[coverage]
script:
${coverageScript}
`);

  const writtenFilePaths = data.testFilePaths;

  if (!writtenFilePaths) {
    throw new ActionError("Test file paths are required for coverage action");
  }

  const relativeFilePaths = writtenFilePaths.map((filePath) =>
    path.isAbsolute(filePath) ? path.relative(baseDir, filePath) : filePath,
  );

  const testFilePaths = relativeFilePaths.join(" ");
  const coverageTemplate = Handlebars.compile(coverageScript);
  const processedCoverageScript = coverageTemplate({
    testFilePaths,
  });

  return (await executeScript({
    script: processedCoverageScript,
    cwd: baseDir,
    commandName: "Coverage",
    commandType: CommandType.FILE,
  })) as IBaseFileCommandResult;
}

async function handleDeleteAction(data: IFileCommandData): Promise<IBaseFileCommandResult> {
  const { filePath: fullFilePath } = setupPaths(data);

  try {
    await fs.unlink(fullFilePath);
    core.info(`
[delete]
File deleted: ${fullFilePath}
`);

    return {
      stdout: `File deleted: ${fullFilePath}`,
      stderr: "",
      exitCode: 0,
      type: CommandType.FILE,
      completedAt: Date.now(),
    };
  } catch (error) {
    if ((error as any).code === "ENOENT") {
      // File doesn't exist, which could be considered success for delete
      core.info(`
[delete]
File does not exist (already deleted): ${fullFilePath}
`);
      return {
        stdout: `File does not exist (already deleted): ${fullFilePath}`,
        stderr: "",
        exitCode: 0,
        type: CommandType.FILE,
        completedAt: Date.now(),
      };
    }

    throw new ActionError(
      `Failed to delete file (${fullFilePath}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function executeScript({
  script,
  cwd,
  commandName,
  commandType,
}: {
  script: string;
  cwd: string;
  commandName: string;
  commandType: CommandType;
}): Promise<IBaseFileCommandResult | IScriptRunnerCommandResult> {
  core.info(`Executing ${commandName.toLowerCase()} script in ${cwd}: ${script}`);

  return new Promise<IBaseFileCommandResult | IScriptRunnerCommandResult>((resolve) => {
    let timeoutDuration = 5 * 60 * 1000; // 5 minute timeout
    if (commandName === "Lint") {
      timeoutDuration = 2 * 60 * 1000; // 2 minute timeout
    } else if (commandName === "Coverage") {
      // Running coverage across multiple files can take a while
      timeoutDuration = 10 * 60 * 1000; // 10 minute timeout
    }

    const maxBufferSize = 10 * 1024 * 1024; // 10 MB buffer

    const child = exec(
      script,
      { cwd, timeout: timeoutDuration, maxBuffer: maxBufferSize },
      (error, stdout, stderr) => {
        const exitCode = error ? (error.code ?? 1) : 0;
        core.info(
          `>>> [exec-callback entry] ${commandName} command finished processing. Script: ${script}`,
        );
        if (stdout) core.info(`[exec-callback] ${commandName} stdout: ${stdout}`);
        if (stderr) core.warning(`[exec-callback] ${commandName} stderr: ${stderr}`);
        if (error) {
          if (error.signal === "SIGTERM" || (error as any).killed) {
            core.warning(
              `[exec-callback] ${commandName} command timed out or was killed. Timeout: ${timeoutDuration / 1000}s.`,
            );
            error.message = `Command timed out or killed (signal: ${error.signal}): ${error.message}`;
          } else {
            core.warning(`[exec-callback] ${commandName} error: ${error.message}`);
          }
        }
        core.info(`[exec-callback] ${commandName} command exited with code ${exitCode}`);

        const baseResultObject = {
          stdout,
          stderr,
          exitCode,
          error: error ? error.message : undefined,
          completedAt: Date.now(),
        };

        if (commandType === CommandType.FILE) {
          const fileResult: IBaseFileCommandResult = {
            ...baseResultObject,
            type: CommandType.FILE,
          };
          resolve(fileResult);
        } else {
          const runnerResult: IScriptRunnerCommandResult = {
            ...baseResultObject,
            type: CommandType.RUNNER,
          };
          resolve(runnerResult);
        }
      },
    );

    // Log when the process exits/closes, separate from the callback
    child.on("exit", (code, signal) => {
      core.info(
        `>>> [exec-exit event] ${commandName} process exited. Code: ${code}, Signal: ${signal}`,
      );
    });
    child.on("close", () => {
      core.info(`>>> [exec-close event] ${commandName} process streams closed.`);
    });
    child.on("error", (err) => {
      // This event fires for errors like command not found, ENOENT, etc.
      core.warning(
        `>>> [exec-process error event] ${commandName} child process error: ${err.message}`,
      );
      // Resolve here might be problematic if the main callback *also* fires.
      // The main callback should handle most errors, including non-zero exit codes.
      // Let's rely on the main callback to resolve.
    });
  });
}
