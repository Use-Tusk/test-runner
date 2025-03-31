import * as core from "@actions/core";
import { FileAction, FileCommand, FileCommandResult, Scripts } from "./types.js";
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
  scripts: Scripts;
}): Promise<void> {
  const { data, actions } = command;

  await ackCommand({ runId, commandId: command.id });

  // Write the file first
  // Use appDir if provided, otherwise use repo root
  const baseDir = data.appDir ? path.join(process.cwd(), data.appDir) : process.cwd();

  // Create full path for the script file (relative to appDir)
  const fullFilePath = path.join(baseDir, data.filePath);
  const fullOriginalFilePath = data.originalFilePath
    ? path.join(baseDir, data.originalFilePath)
    : data.originalFilePath;

  core.info(`Full file path: ${fullFilePath}`);
  core.info(`Full original file path: ${fullOriginalFilePath}`);

  // Ensure directory exists
  await fs.mkdir(path.dirname(fullFilePath), { recursive: true });

  let lastCommandStdout = "";
  let lastCommandStderr = "";
  let lastCommandExitCode = 0;

  if (actions.includes(FileAction.WRITE)) {
    core.info("Writing file");

    if (!data.fileContents) {
      core.error("File contents are required for write action");
      lastCommandStdout = "";
      lastCommandStderr = "File contents are required for write action";
      lastCommandExitCode = 1;
      return;
    }

    await fs.writeFile(fullFilePath, data.fileContents, { encoding: "utf8" });
    core.info(`File written to ${fullFilePath}`);
  }

  if (scripts.lint && actions.includes(FileAction.LINT)) {
    core.info("Linting file");
    const lintTemplate = Handlebars.compile(scripts.lint);
    const processedLintScript = lintTemplate({
      file: fullFilePath,
    });

    try {
      const result = await executeScript(processedLintScript, baseDir, "Lint");
      lastCommandStdout = result.stdout;
      lastCommandStderr = result.stderr;
      lastCommandExitCode = result.exitCode;
    } catch (err) {
      core.error(`Failed to execute lint command: ${err}`);
      lastCommandStdout = "";
      lastCommandStderr = String(err);
      lastCommandExitCode = 1;
    }
  }

  if (actions.includes(FileAction.READ)) {
    try {
      core.info("Reading file");
      const fileContents = await fs.readFile(fullFilePath, { encoding: "utf8" });
      core.info(`File contents: ${fileContents}`);
      lastCommandStdout = fileContents;
      lastCommandStderr = "";
      lastCommandExitCode = 0;
    } catch (err) {
      core.error(`Failed to read file: ${err}`);
      lastCommandStdout = "";
      lastCommandStderr = String(err);
      lastCommandExitCode = 1;
    }
  }

  if (actions.includes(FileAction.TEST)) {
    core.info("Testing file");
    const testTemplate = Handlebars.compile(scripts.test);
    const processedTestScript = testTemplate({
      file: fullFilePath,
    });

    try {
      const result = await executeScript(processedTestScript, baseDir, "Test");
      lastCommandStdout = result.stdout;
      lastCommandStderr = result.stderr;
      lastCommandExitCode = result.exitCode;
    } catch (err) {
      core.error(`Failed to execute test command: ${err}`);
      lastCommandStdout = "";
      lastCommandStderr = String(err);
      lastCommandExitCode = 1;
    }
  }

  if (scripts.coverage && actions.includes(FileAction.COVERAGE)) {
    core.info("Generating coverage report");

    const writtenFilePaths = command.data.testFilePaths;

    if (!writtenFilePaths) {
      core.error("Test file paths are required for coverage action");
      lastCommandStdout = "";
      lastCommandStderr = "Test file paths are required for coverage action";
      lastCommandExitCode = 1;
      return;
    }

    const relativeFilePaths = writtenFilePaths.map((filePath) => {
      return path.isAbsolute(filePath) ? path.relative(baseDir, filePath) : filePath;
    });

    const testFilePaths = relativeFilePaths.join(" ");

    const coverageTemplate = Handlebars.compile(scripts.coverage);
    const processedCoverageScript = coverageTemplate({
      testFilePaths,
    });

    try {
      const result = await executeScript(processedCoverageScript, baseDir, "Coverage");
      lastCommandStdout = result.stdout;
      lastCommandStderr = result.stderr;
      lastCommandExitCode = result.exitCode;
    } catch (err) {
      core.error(`Failed to execute coverage command: ${err}`);
      lastCommandStdout = "";
      lastCommandStderr = String(err);
      lastCommandExitCode = 1;
    }
  }

  const commandResult: FileCommandResult = {
    commandId: command.id,
    type: "file",
    completedAt: new Date(),
    stdout: lastCommandStdout,
    stderr: lastCommandStderr,
    exitCode: lastCommandExitCode,
    error: lastCommandExitCode !== 0 ? lastCommandStderr : undefined,
  };

  await sendCommandResult({ runId, result: commandResult });
}

async function executeScript(
  script: string,
  cwd: string,
  commandType: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  core.info(`Executing ${commandType.toLowerCase()} script: ${script}`);

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
