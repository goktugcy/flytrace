/**
 * Typed application error hierarchy.
 * Every failure crossing a boundary becomes an AppError with a stable `code`,
 * an HTTP status, and a `retryable` flag. The API maps these to the standard
 * error envelope; internal details never leak to clients.
 */

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'FLIGHT_NOT_FOUND'
  | 'CONFLICT'
  | 'ALREADY_WATCHING'
  | 'RATE_LIMITED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'INTERNAL';

export interface AppErrorOptions {
  httpStatus?: number;
  retryable?: boolean;
  details?: unknown;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, opts: AppErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = opts.httpStatus ?? defaultStatus(code);
    this.retryable = opts.retryable ?? defaultRetryable(code);
    if (opts.details !== undefined) this.details = opts.details;
  }

  toEnvelope(requestId?: string) {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
        ...(requestId ? { requestId } : {}),
      },
    };
  }
}

function defaultStatus(code: ErrorCode): number {
  switch (code) {
    case 'BAD_REQUEST':
      return 400;
    case 'VALIDATION_ERROR':
      return 422;
    case 'UNAUTHENTICATED':
      return 401;
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
    case 'FLIGHT_NOT_FOUND':
      return 404;
    case 'CONFLICT':
    case 'ALREADY_WATCHING':
      return 409;
    case 'RATE_LIMITED':
      return 429;
    case 'UPSTREAM_UNAVAILABLE':
      return 503;
    default:
      return 500;
  }
}

function defaultRetryable(code: ErrorCode): boolean {
  return code === 'UPSTREAM_UNAVAILABLE' || code === 'RATE_LIMITED' || code === 'INTERNAL';
}

/** Convenience constructors. */
export const errors = {
  badRequest: (m = 'Bad request', d?: unknown) => new AppError('BAD_REQUEST', m, { details: d }),
  validation: (m = 'Validation failed', d?: unknown) =>
    new AppError('VALIDATION_ERROR', m, { details: d }),
  unauthenticated: (m = 'Authentication required') => new AppError('UNAUTHENTICATED', m),
  forbidden: (m = 'Forbidden') => new AppError('FORBIDDEN', m),
  notFound: (m = 'Not found') => new AppError('NOT_FOUND', m),
  flightNotFound: (m = 'Flight not found') => new AppError('FLIGHT_NOT_FOUND', m),
  conflict: (m = 'Conflict') => new AppError('CONFLICT', m),
  rateLimited: (m = 'Too many requests') => new AppError('RATE_LIMITED', m),
  upstream: (m = 'Upstream unavailable', cause?: unknown) =>
    new AppError('UPSTREAM_UNAVAILABLE', m, { cause }),
  internal: (m = 'Internal error', cause?: unknown) => new AppError('INTERNAL', m, { cause }),
};

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
