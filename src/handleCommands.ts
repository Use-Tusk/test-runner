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
} from "./types.js";
import { exec } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import Handlebars from "handlebars";
import { ackCommand, sendCommandResult } from "./requests.js";
import { ActionError } from "./errors.js";

export async function processCommand({
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

  await ackCommand({ runId, commandId });

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
  } else if (skipIfMissingLintScript) {
    core.warning("Lint script is missing. Skipping lint action.");
    return {
      stdout: "",
      stderr: "Lint script missing or invalid, skipping lint action.",
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

  return await executeScript({
    script: processedLintScript,
    cwd: baseDir,
    commandType: "Lint",
  });
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

  const readResult = await handleReadAction(data);
  return readResult;
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

  const result = await executeScript({
    script: processedTestScript,
    cwd: baseDir,
    commandType: "Test",
  });

  core.info(`
[test]
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

  return await executeScript({
    script: processedCoverageScript,
    cwd: baseDir,
    commandType: "Coverage",
  });
}

async function executeScript({
  script,
  cwd,
  commandType,
}: {
  script: string;
  cwd: string;
  commandType: string;
}): Promise<IBaseFileCommandResult> {
  core.info(`Executing ${commandType.toLowerCase()} script in ${cwd}: ${script}`);

  return new Promise<IBaseFileCommandResult>((resolve) => {
    exec(script, { cwd }, (error, stdout, stderr) => {
      const exitCode = error ? (error.code ?? 1) : 0;
      if (stdout) core.info(`${commandType} stdout: ${stdout}`);
      if (stderr) core.warning(`${commandType} stderr: ${stderr}`);
      if (error) {
        core.warning(`${commandType} error: ${error.message}`);
      }
      core.info(`${commandType} command exited with code ${exitCode}`);
      resolve({
        stdout,
        stderr,
        exitCode,
        type: CommandType.FILE,
        completedAt: Date.now(),
      });
    });
  });
}
