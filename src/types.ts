export interface CommandResult {
  exitCode: number;
  error?: string;
  stdout: string;
  stderr: string;
}

export enum CommandType {
  FILE = "file",
  RUNNER = "runner",
}

export enum FileAction {
  READ = "read",
  WRITE = "write",
  LINT = "lint",
  TEST = "test",
  LINT_READ = "lint_read",
  WRITE_LINT_READ = "write_lint_read",
  COVERAGE = "coverage",
  DELETE = "delete",
}

export enum RunnerAction {
  TERMINATE = "terminate",
  SCRIPT = "script",
}

export interface IFileCommandData {
  filePath: string;
  fileContents?: string;
  originalFilePath?: string; // For running test which require both source and test files (e.g., Go tests)
  appDir?: string;
  testFilePaths?: string[]; // For test coverage
}

export interface IRunnerCommandData {
  script?: string;
}

export interface IFileCommand {
  type: CommandType.FILE;
  action: FileAction;
  data: IFileCommandData;
}

export interface IRunnerCommand {
  type: CommandType.RUNNER;
  action: RunnerAction;
  data?: IRunnerCommandData; // For raw script commands
}

export type ICommandInfo = IFileCommand | IRunnerCommand;

export interface IBaseResult {
  completedAt: number; // Epoch time
}

export interface IBaseCommandResult extends IBaseResult, CommandResult {}

export interface IBaseFileCommandResult extends IBaseCommandResult {
  type: CommandType.FILE;
}

export interface IReadFileCommandResult extends IBaseFileCommandResult {
  fileContents: string;
}

export type IFileCommandResult = IBaseFileCommandResult | IReadFileCommandResult;

// Returned by terminate command
export interface IBaseRunnerCommandResult extends IBaseResult {
  type: CommandType.RUNNER;
}

// Returned by raw script command
export interface IScriptRunnerCommandResult extends IBaseRunnerCommandResult, IBaseCommandResult {}

export type IRunnerCommandResult = IBaseRunnerCommandResult | IScriptRunnerCommandResult;

export type ICommandResult = IFileCommandResult | IRunnerCommandResult;

// Shared between the GithubActionController and the GH runner
export interface IActionCommand {
  id: string;
  createdAt: Date;
  command: ICommandInfo;
}

// Shared between the GithubActionController and the GH runner
export interface IActionCommandResult {
  id: string;
  result: ICommandResult;
}

export interface ScriptData {
  test: string;
  lint?: string;
  coverage?: string;
}

export interface AbsolutePathData {
  baseDir: string;
  filePath: string;
  originalFilePath?: string; // Only used in Go tests
}

export interface ITestExecutionConfig {
  maxConcurrency?: number;
}

export interface ITestingSandboxConfigInfo {
  testingSandboxConfigId: string;
  testExecutionConfig: ITestExecutionConfig;
}
