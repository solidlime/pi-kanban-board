export type ErrorCode =
  | "BAD_REQUEST" | "UNAUTHORIZED" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT"
  | "VALIDATION" | "WIP_LIMIT" | "CYCLE" | "STALE_VERSION" | "INTERNAL";

export interface ApiError { code: ErrorCode; message: string; details?: unknown }
export type ApiOk<T> = { ok: true; data: T };
export type ApiFail = { ok: false; error: ApiError };
export type ApiEnvelope<T> = ApiOk<T> | ApiFail;

export function ok<T>(data: T): ApiOk<T> { return { ok: true, data }; }
export function fail(code: ErrorCode, message: string, details?: unknown): ApiFail {
  return { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } };
}

export class DomainError extends Error {
  // Not a parameter property: node's strip-only TS loader rejects those, and v2 src/*.ts
  // is imported directly by tests without a build step.
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}
