export class ActionError extends Error {
  constructor(message: string) {
    super(`ActionError: ${message}`);
    this.name = "ActionError";

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ActionError);
    }
  }
}
