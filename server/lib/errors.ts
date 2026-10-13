import { ZodError } from 'zod';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function asAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError) {
    return new AppError(400, 'validation_error', 'One or more fields are invalid.', error.flatten());
  }
  if (error && typeof error === 'object') {
    const fastifyError = error as { code?: unknown; statusCode?: unknown; message?: unknown };
    const code = typeof fastifyError.code === 'string' ? fastifyError.code : undefined;
    const statusCode = typeof fastifyError.statusCode === 'number' ? fastifyError.statusCode : undefined;
    if (code === 'FST_ERR_CTP_INVALID_JSON_BODY') {
      return new AppError(400, 'invalid_json', 'Request body must be valid JSON.');
    }
    if (code === 'FST_REQ_FILE_TOO_LARGE') {
      return new AppError(413, 'upload_too_large', 'The uploaded file exceeds NodePilot\'s configured size limit.');
    }
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      return new AppError(statusCode, 'bad_request', typeof fastifyError.message === 'string' ? fastifyError.message : 'The request could not be processed.');
    }
  }
  if (error instanceof Error) {
    return new AppError(500, 'internal_error', 'An unexpected server error occurred.');
  }
  return new AppError(500, 'internal_error', 'An unexpected server error occurred.');
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}
