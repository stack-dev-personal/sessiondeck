/** Why a sprint state file operation failed. Callers branch on `kind`, never on message text. */
export type StateFileErrorKind =
  | "invalid-id"
  | "secret"
  | "schema"
  | "write-failed"
  | "not-found"
  | "invalid-json"
  | "read-failed"
  | "usage";

export class StateFileError extends Error {
  readonly kind: StateFileErrorKind;

  constructor(kind: StateFileErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StateFileError";
    this.kind = kind;
  }
}

/** Node errors carry a string `code`; anything else yields undefined. */
export function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}
