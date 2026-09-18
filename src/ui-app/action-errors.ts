/** Safe, actionable presentation-storage failures.
 *
 * The underlying error remains the cause for diagnostics.  UI copy must not
 * expose a runner, storage, or response receipt implementation detail.
 */
export class PresentationPersistenceError extends Error {
  readonly code = "PRESENTATION_SAVE_FAILED" as const;
  readonly recovery = "save_then_retry" as const;

  constructor(action: string, cause: Error) {
    super(messageFor(action), { cause });
    this.name = "PresentationPersistenceError";
  }
}

export function persistenceSaveError(action: string | undefined, cause: Error): PresentationPersistenceError {
  return new PresentationPersistenceError(action?.trim().toLowerCase() || "answers", cause);
}

function messageFor(action: string): string {
  if (action === "run preparation") return "The run preparation could not be saved. Save it before starting.";
  return "Your answers could not be saved. Save them before submitting.";
}
