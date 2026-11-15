/** Classified application errors. `code` is stable and safe to show to clients. */
export type ErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "NOT_CONFIGURED"
  | "LLM_ERROR"
  | "LLM_RATE_LIMIT"
  | "LLM_INVALID_OUTPUT"
  | "LLM_REFUSAL"
  | "SEARCH_ERROR"
  | "SEARCH_TIMEOUT"
  | "BUDGET_EXCEEDED"
  | "TIMEOUT"
  | "CANCELLED"
  | "CONFLICT"
  | "INTERNAL";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly status: number;
  override readonly cause?: unknown;

  constructor(code: ErrorCode, message: string, opts: { retryable?: boolean; status?: number; cause?: unknown } = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.status = opts.status ?? defaultStatus(code);
    this.cause = opts.cause;
  }
}

function defaultStatus(code: ErrorCode): number {
  switch (code) {
    case "VALIDATION":
      return 400;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
      return 409;
    case "NOT_CONFIGURED":
      return 503;
    case "LLM_RATE_LIMIT":
      return 429;
    case "TIMEOUT":
    case "SEARCH_TIMEOUT":
      return 504;
    default:
      return 500;
  }
}

export function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.name === "TimeoutError" || (err as { code?: string }).code === "ABORT_ERR")
  );
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (isAbortError(err)) {
    const isTimeout = err instanceof Error && err.name === "TimeoutError";
    return new AppError(isTimeout ? "TIMEOUT" : "CANCELLED", isTimeout ? "The request took too long." : "The request was cancelled.", {
      retryable: isTimeout,
      cause: err,
    });
  }
  return new AppError("INTERNAL", "Unexpected internal error.", { cause: err });
}
