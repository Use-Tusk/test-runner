import * as core from "@actions/core";
import {
  FileAction,
  FileCommand,
  FileCommandResult,
  AbsolutePathData,
  ScriptData,
} from "./types.js";
import { exec } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import Handlebars from "handlebars";
import { ackCommand, sendCommandResult } from "./requests.js";

export async function processCommand({
  command,
  runId,
  scripts,
}: {
  command: FileCommand;
  runId: string;
  scripts: ScriptData;
}): Promise<void> {
  const { data, actions } = command;

  await ackCommand({ runId, commandId: command.id });

  // Setup paths
  const {
    baseDir,
    filePath: fullFilePath,
    originalFilePath: fullOriginalFilePath,
  } = setupPaths(data);

  // Ensure directory exists
  await fs.mkdir(path.dirname(fullFilePath), { recursive: true });

  let result = { stdout: "", stderr: "", exitCode: 0 };

  try {
    // Process each action in sequence
    if (actions.includes(FileAction.WRITE)) {
      result = await handleWriteAction({ fullFilePath, data });
    }

    if (scripts.lint && actions.includes(FileAction.LINT)) {
      result = await handleLintAction({ lintScript: scripts.lint, baseDir, fullFilePath });
    }

    if (actions.includes(FileAction.READ)) {
      result = await handleReadAction({ fullFilePath });
    }

    if (actions.includes(FileAction.TEST)) {
      result = await handleTestAction({
        testScript: scripts.test,
        baseDir,
        fullFilePath,
        fullOriginalFilePath,
        data,
      });
    }

    if (scripts.coverage && actions.includes(FileAction.COVERAGE)) {
      result = await handleCoverageAction({
        coverageScript: scripts.coverage,
        baseDir,
        data,
      });
    }
  } catch (error) {
    result = {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: 1,
    };
  }

  const commandResult: FileCommandResult = {
    commandId: command.id,
    type: "file",
    completedAt: new Date(),
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    error: result.exitCode !== 0 ? result.stderr : undefined,
  };

  core.info(`
[result]
${JSON.stringify(commandResult, null, 2)}
`);

  await sendCommandResult({ runId, result: commandResult });
}

function setupPaths(data: FileCommand["data"]): AbsolutePathData {
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

async function handleWriteAction({
  fullFilePath,
  data,
}: {
  fullFilePath: string;
  data: FileCommand["data"];
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (!data.fileContents) {
    throw new Error("File contents are required for write action");
  }

  await fs.writeFile(fullFilePath, data.fileContents, { encoding: "utf8" });
  core.info(`
[write]
File written to ${fullFilePath}
`);

  return { stdout: "", stderr: "", exitCode: 0 };
}

async function handleReadAction({
  fullFilePath,
}: {
  fullFilePath: string;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const fileContents = await fs.readFile(fullFilePath, { encoding: "utf8" });
  core.info(`
[read]
File: ${fullFilePath}
Contents;
${fileContents}
`);
  return { stdout: fileContents, stderr: "", exitCode: 0 };
}

async function handleLintAction({
  lintScript,
  baseDir,
  fullFilePath,
}: {
  lintScript: string;
  baseDir: string;
  fullFilePath: string;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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

async function handleTestAction({
  testScript,
  baseDir,
  fullFilePath,
  fullOriginalFilePath,
  data,
}: {
  testScript: string;
  baseDir: string;
  fullFilePath: string;
  fullOriginalFilePath: string | undefined;
  data: FileCommand["data"];
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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

async function handleCoverageAction({
  coverageScript,
  baseDir,
  data,
}: {
  coverageScript: string;
  baseDir: string;
  data: FileCommand["data"];
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  core.info(`
[coverage]
script:
${coverageScript}
`);

  const writtenFilePaths = data.testFilePaths;
  if (!writtenFilePaths) {
    throw new Error("Test file paths are required for coverage action");
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
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  core.info(`Executing ${commandType.toLowerCase()} script in ${cwd}: ${script}`);

  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
    exec(script, { cwd }, (error, stdout, stderr) => {
      const exitCode = error ? (error.code ?? 1) : 0;
      if (stdout) core.info(`${commandType} stdout: ${stdout}`);
      if (stderr) core.warning(`${commandType} stderr: ${stderr}`);
      if (error) {
        core.warning(`${commandType} error: ${error.message}`);
      }
      core.info(`${commandType} command exited with code ${exitCode}`);
      resolve({ stdout, stderr, exitCode });
    });
  });
}
