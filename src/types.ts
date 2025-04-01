export interface BaseCommand {
  id: string;
  createdAt: Date;
}

export interface FileData {
  filePath: string;
  fileContents?: string;
  originalFilePath?: string;
  appDir?: string;
  testFilePaths?: string[]; // For test coverage
}

export enum FileAction {
  READ = "read",
  WRITE = "write",
  LINT = "lint",
  TEST = "test",
  COVERAGE = "coverage",
}

export enum RunnerAction {
  TERMINATE = "terminate",
}

export interface FileCommand extends BaseCommand {
  type: "file";
  actions: FileAction[];
  data: FileData;
}

export interface RunnerCommand extends BaseCommand {
  type: "runner";
  actions: RunnerAction[];
}

export type Command = FileCommand | RunnerCommand;

export interface FileCommandResult {
  commandId: string;
  type: "file";
  exitCode: number;
  error?: string;
  stdout: string;
  stderr: string;
  completedAt: Date;
}

export interface RunnerCommandResult {
  commandId: string;
  type: "runner";
  completedAt: Date;
}

export type CommandResult = FileCommandResult | RunnerCommandResult;

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
