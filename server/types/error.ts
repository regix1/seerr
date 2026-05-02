import type { ApiErrorCode } from '@server/constants/error';

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public errorCode: ApiErrorCode,
    message?: string
  ) {
    super(message ?? `API error ${statusCode} (${errorCode})`);

    this.name = 'apiError';
  }
}
