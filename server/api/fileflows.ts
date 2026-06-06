import ExternalAPI from '@server/api/externalapi';

export interface FileFlowsProcessingFile {
  name: string;
  relativePath?: string;
  // The FileFlows library a file belongs to, e.g. "Movie: Video Library" or
  // "TV Show: Video Library" — a cheap movie-vs-tv hint for resolution.
  library?: string;
  step?: string;
  stepPercent?: number;
}

export interface FileFlowsStatus {
  processing: number;
  queue: number;
  processingFiles: FileFlowsProcessingFile[];
}

interface FileFlowsAPIOptions {
  hostname: string;
  port: number;
  useSsl?: boolean;
  apiKey?: string;
  urlBase?: string;
  timeout?: number;
}

class FileFlowsAPI extends ExternalAPI {
  constructor({
    hostname,
    port,
    useSsl = false,
    apiKey,
    urlBase,
    timeout = 10000,
  }: FileFlowsAPIOptions) {
    const protocol = useSsl ? 'https' : 'http';
    const normalizedUrlBase = urlBase
      ? `/${urlBase.replace(/^\/+|\/+$/g, '')}`
      : '';

    super(
      `${protocol}://${hostname}:${port}${normalizedUrlBase}/api`,
      {},
      {
        // FileFlows is unauthenticated by default; when an access token is
        // configured it is sent as the `x-token` header.
        headers: apiKey ? { 'x-token': apiKey } : {},
        timeout,
      }
    );
  }

  /**
   * Fetch the lightweight dashboard status, including the list of files
   * FileFlows is actively processing right now. ttl 0 disables caching here —
   * the FileFlows tracker owns the short-lived cache.
   */
  public async getStatus(): Promise<FileFlowsStatus> {
    return this.get<FileFlowsStatus>('/status', undefined, 0);
  }
}

export default FileFlowsAPI;
