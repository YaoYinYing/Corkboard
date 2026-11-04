export type ErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "BODY_EXPIRED"
  | "REQUEST_TOO_LARGE"
  | "UNAVAILABLE"
  | "INTEGRITY_MISMATCH"
  | "INTEGRITY_FAILURE";

const HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  BODY_EXPIRED: 410,
  REQUEST_TOO_LARGE: 413,
  UNAVAILABLE: 503,
  // Client supplied a digest that does not match the received bytes: fixable input.
  INTEGRITY_MISMATCH: 400,
  // Stored content failed verification after commit: server-side failure.
  INTEGRITY_FAILURE: 500,
};

const DEFAULT_MESSAGE: Readonly<Record<ErrorCode, string>> = {
  UNAUTHENTICATED: "Authentication required",
  FORBIDDEN: "Not allowed",
  NOT_FOUND: "Not found",
  VALIDATION_ERROR: "Invalid request",
  CONFLICT: "Conflicting request",
  RATE_LIMITED: "Too many requests",
  BODY_EXPIRED: "Body expired",
  REQUEST_TOO_LARGE: "Request too large",
  UNAVAILABLE: "Service unavailable",
  INTEGRITY_MISMATCH: "Digest does not match the received bytes",
  INTEGRITY_FAILURE: "Stored content failed verification",
};

export function httpStatusFor(code: ErrorCode): number {
  return HTTP_STATUS[code];
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;

  constructor(code: ErrorCode, message?: string) {
    super(message ?? DEFAULT_MESSAGE[code]);
    this.name = "AppError";
    this.code = code;
    this.httpStatus = httpStatusFor(code);
  }
}

// Carries the Retry-After hint without widening AppError for every caller.
export class RateLimitError extends AppError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("RATE_LIMITED");
    this.name = "RateLimitError";
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  }
}
