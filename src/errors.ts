export class AppError extends Error {
  statusCode: number;
  code: string;
  details?: unknown;
  expose: boolean;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.expose = statusCode < 500;
  }
}

export function assert(condition: unknown, statusCode: number, code: string, message: string, details?: unknown): asserts condition {
  if (!condition) throw new AppError(statusCode, code, message, details);
}
