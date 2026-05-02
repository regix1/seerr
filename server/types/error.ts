import type { ApiErrorCode } from '@server/constants/error';

interface ApiErrorDetails {
  requestUrl?: string;
  responseData?: unknown;
}

export class ApiError extends Error {
  public requestUrl?: string;
  public responseData?: unknown;

  constructor(
    public statusCode: number,
    public errorCode: ApiErrorCode,
    message?: string,
    details: ApiErrorDetails = {}
  ) {
    super(message ?? `API error ${statusCode} (${errorCode})`);

    this.name = 'apiError';
    this.requestUrl = details.requestUrl;
    this.responseData = details.responseData;
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}
