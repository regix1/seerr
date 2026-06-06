import ExternalAPI from '@server/api/externalapi';

export interface FileFlowsProcessingFile {
  name: string;
  relativePath?: string;
}

export interface FileFlowsStatus {
  processing: number;
  queue: number;
  processingFiles: FileFlowsProcessingFile[];
}

// Rich per-file metadata FileFlows attaches once a Movie/TV "lookup" node has
// run in the flow. Fields are PascalCase (FileFlows serializes its .NET objects
// verbatim) and every field is optional — MetaInfo stays empty until a lookup
// node populates it, so callers must always be able to fall back to the name.
export interface FileFlowsMetaInfo {
  MetaId?: string | number | null;
  Title?: string | null;
  Subtitle?: string | null;
  SeasonNumber?: number | null;
  EpisodeNumber?: number | null;
  LastEpisodeNumber?: number | null;
  Type?: number | null;
}

export interface FileFlowsLibraryFile {
  Uid?: string;
  Name?: string;
  RelativePath?: string;
  MetaInfo?: FileFlowsMetaInfo | null;
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

  /**
   * List the files FileFlows is currently Processing (FileStatus 2), including
   * the rich MetaInfo (title / TMDB id / season-episode) FileFlows resolved for
   * each. Best-effort: older builds, or instances whose flow never ran a lookup
   * node, return sparse objects — callers must treat every field as optional
   * and fall back to parsing the file name.
   */
  public async getProcessingLibraryFiles(): Promise<FileFlowsLibraryFile[]> {
    const response = await this.axios.get<FileFlowsLibraryFile[]>(
      '/library-file',
      { params: { status: 2 } }
    );
    return Array.isArray(response.data) ? response.data : [];
  }
}

export default FileFlowsAPI;
