/* eslint-disable @typescript-eslint/no-explicit-any */
import ExternalAPI from '@server/api/externalapi';
import { ApiErrorCode } from '@server/constants/error';
import { MediaServerType } from '@server/constants/server';
import availabilitySync from '@server/lib/availabilitySync';
import type { EmbySettings, JellyfinSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { ApiError } from '@server/types/error';
import { getAppVersion } from '@server/utils/appVersion';

export interface JellyfinUserResponse {
  Name: string;
  ServerId: string;
  ServerName: string;
  Id: string;
  Configuration: {
    GroupedFolders: string[];
  };
  Policy: {
    IsAdministrator: boolean;
  };
  PrimaryImageTag?: string;
}

export interface JellyfinDevice {
  Id: string;
  Name: string;
  LastUserName: string;
  AppName: string;
  AppVersion: string;
  LastUserId: string;
  DateLastActivity: string;
  Capabilities: Record<string, unknown>;
}

export interface JellyfinDevicesResponse {
  Items: JellyfinDevice[];
  TotalRecordCount: number;
  StartIndex: number;
}

export interface JellyfinLoginResponse {
  User: JellyfinUserResponse;
  AccessToken: string;
}

export interface JellyfinUserListResponse {
  users: JellyfinUserResponse[];
}

interface JellyfinMediaFolder {
  Name: string;
  Id: string;
  Type: string;
  CollectionType: string;
}

export interface JellyfinLibrary {
  type: 'show' | 'movie';
  key: string;
  title: string;
  agent: string;
}

export interface JellyfinLibraryItem {
  Name: string;
  Id: string;
  HasSubtitles: boolean;
  Type: 'Movie' | 'Episode' | 'Season' | 'Series';
  LocationType: 'FileSystem' | 'Offline' | 'Remote' | 'Virtual';
  SeriesName?: string;
  SeriesId?: string;
  SeasonId?: string;
  SeasonName?: string;
  IndexNumber?: number;
  IndexNumberEnd?: number;
  ParentIndexNumber?: number;
  MediaType: string;
}

export interface JellyfinMediaStream {
  Codec: string;
  Type: 'Video' | 'Audio' | 'Subtitle';
  Height?: number;
  Width?: number;
  AverageFrameRate?: number;
  RealFrameRate?: number;
  Language?: string;
  DisplayTitle: string;
}

export interface JellyfinMediaSource {
  Protocol: string;
  Id: string;
  Path: string;
  Type: string;
  VideoType: string;
  MediaStreams: JellyfinMediaStream[];
}

export interface JellyfinLibraryItemExtended extends JellyfinLibraryItem {
  ProviderIds: {
    Tmdb?: string;
    TheMovieDb?: string;
    Imdb?: string;
    Tvdb?: string;
    AniDB?: string;
  };
  MediaSources?: JellyfinMediaSource[];
  Width?: number;
  Height?: number;
  IsHD?: boolean;
  DateCreated?: string;
}

type EpisodeReturn<T> = T extends { includeMediaInfo: true }
  ? JellyfinLibraryItemExtended[]
  : JellyfinLibraryItem[];

export interface JellyfinItemsReponse {
  Items: JellyfinLibraryItemExtended[];
  TotalRecordCount: number;
  StartIndex: number;
}

class JellyfinAPI extends ExternalAPI {
  private userId?: string;
  private mediaServerType: MediaServerType;

  constructor(
    jellyfinHost: string,
    authToken?: string | null,
    deviceId?: string | null,
    mediaServerType?: MediaServerType
  ) {
    const settings = getSettings();
    const resolvedMediaServerType =
      mediaServerType ?? settings.main.mediaServerType;
    const safeDeviceId =
      deviceId && deviceId.length > 0
        ? deviceId
        : Buffer.from('BOT_seerr').toString('base64');

    const version =
      resolvedMediaServerType === MediaServerType.EMBY
        ? '1.0.0'
        : getAppVersion();

    let authHeaderVal = `MediaBrowser Client="Seerr", Device="Seerr", DeviceId="${safeDeviceId}", Version="${version}"`;
    if (authToken) {
      authHeaderVal += `, Token="${authToken}"`;
    }

    super(
      jellyfinHost,
      {},
      {
        headers: {
          Authorization: authHeaderVal,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      }
    );

    this.mediaServerType = resolvedMediaServerType;
  }

  /**
   * Compute the hostname URL for a Jellyfin or Emby settings block.
   * Mirrors the format used by `getHostname` in @server/utils/getHostname.
   */
  private static computeUrl(settings: {
    useSsl?: boolean;
    ip: string;
    port: number;
    urlBase?: string;
  }): string {
    const useSsl = settings.useSsl ?? false;
    const urlBase = settings.urlBase ?? '';
    return `${useSsl ? 'https' : 'http'}://${settings.ip}:${
      settings.port
    }${urlBase}`;
  }

  /**
   * Build a JellyfinAPI client targeting a Jellyfin server.
   */
  public static forJellyfin(
    settings: JellyfinSettings,
    userToken?: string | null,
    deviceId?: string | null
  ): JellyfinAPI {
    const url = JellyfinAPI.computeUrl(settings);
    return new JellyfinAPI(url, userToken, deviceId, MediaServerType.JELLYFIN);
  }

  /**
   * Build a JellyfinAPI client targeting an Emby server.
   * Emby and Jellyfin share the MediaBrowser API so the same client class works for both,
   * but version handshake / branding differ — distinguished via MediaServerType.
   */
  public static forEmby(
    settings: EmbySettings,
    userToken?: string | null,
    deviceId?: string | null
  ): JellyfinAPI {
    const url = JellyfinAPI.computeUrl(settings);
    return new JellyfinAPI(url, userToken, deviceId, MediaServerType.EMBY);
  }

  public async login(
    Username?: string,
    Password?: string,
    ClientIP?: string
  ): Promise<JellyfinLoginResponse> {
    const authenticate = async (useHeaders: boolean) => {
      const headers =
        useHeaders && ClientIP ? { 'X-Forwarded-For': ClientIP } : {};

      return this.post<JellyfinLoginResponse>(
        '/Users/AuthenticateByName',
        {
          Username,
          Pw: Password,
        },
        { headers }
      );
    };

    try {
      return await authenticate(true);
    } catch (e) {
      logger.debug('Failed to authenticate with headers', {
        label: 'Jellyfin API',
        error: e.response?.statusText,
        ip: ClientIP,
      });

      if (!e.response?.status) {
        throw new ApiError(404, ApiErrorCode.InvalidUrl);
      }

      if (e.response?.status === 401) {
        throw new ApiError(e.response?.status, ApiErrorCode.InvalidCredentials);
      }
    }

    try {
      return await authenticate(false);
    } catch (e) {
      if (e.response?.status === 401) {
        throw new ApiError(e.response?.status, ApiErrorCode.InvalidCredentials);
      }

      logger.error(
        `Something went wrong while authenticating with the Jellyfin server: ${e.message}`,
        {
          label: 'Jellyfin API',
          error: e.response?.status,
          ip: ClientIP,
        }
      );

      throw new ApiError(e.response?.status, ApiErrorCode.Unknown);
    }
  }

  public setUserId(userId: string): void {
    if (!userId) {
      throw new Error(
        `JellyfinAPI.setUserId called with empty value — the caller must resolve a valid user ID before constructing the API client.`
      );
    }
    this.userId = userId;
  }

  private get apiLabel(): string {
    return this.mediaServerType === MediaServerType.EMBY
      ? 'Emby API'
      : 'Jellyfin API';
  }

  private getRequestPath(
    endpoint: string,
    params: Record<string, string>
  ): string {
    const queryString = new URLSearchParams(params).toString();

    return `${endpoint}?${queryString}`;
  }

  private getErrorDetails(error: unknown): {
    status: number;
    message: string;
    responseData?: unknown;
  } {
    const status =
      error instanceof Object && 'response' in error
        ? ((error as { response?: { status?: number } }).response?.status ??
          500)
        : 500;
    const responseData =
      error instanceof Object && 'response' in error
        ? (error as { response?: { data?: unknown } }).response?.data
        : undefined;

    return {
      status,
      message: error instanceof Error ? error.message : String(error),
      responseData,
    };
  }

  public async getSystemInfo(): Promise<any> {
    try {
      const systemInfoResponse = await this.get<any>('/System/Info');

      return systemInfoResponse;
    } catch (e) {
      throw new ApiError(e.response?.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  public async getServerName(): Promise<string> {
    try {
      const serverResponse = await this.get<JellyfinUserResponse>(
        '/System/Info/Public'
      );

      return serverResponse.ServerName;
    } catch (e) {
      logger.error(
        `Something went wrong while getting the server name from the Jellyfin server: ${e.message}`,
        { label: 'Jellyfin API', error: e.response?.status }
      );

      throw new ApiError(e.response?.status, ApiErrorCode.Unknown);
    }
  }

  /**
   * Fetch the unauthenticated public-info payload from the media server.
   * Both Jellyfin and Emby expose `/System/Info/Public` and include a
   * `ProductName` field whose value is the canonical brand identifier
   * ("Jellyfin Server" or "Emby Server"). Returns null on network failure
   * so callers can decide whether to fall back rather than throwing.
   */
  public async getServerPublicInfo(): Promise<{
    productName: string;
    serverName: string;
    version: string;
    id: string;
  } | null> {
    try {
      const response = await this.get<{
        ProductName?: string;
        ServerName?: string;
        Version?: string;
        Id?: string;
      }>('/System/Info/Public');
      return {
        productName: response?.ProductName ?? '',
        serverName: response?.ServerName ?? '',
        version: response?.Version ?? '',
        id: response?.Id ?? '',
      };
    } catch (e) {
      logger.debug('Failed to fetch /System/Info/Public', {
        label: 'Jellyfin API',
        errorMessage: (e as Error).message,
      });
      return null;
    }
  }

  /**
   * Method B — probe the /emby/ path prefix that only Emby's routing middleware
   * registers. Jellyfin returns 404 for this prefix; Emby returns 200.
   *
   * Bug 4 fix: strip an existing trailing /emby segment from the base URL before
   * appending /emby/ so users whose URL is already "http://host/emby" don't end
   * up hitting ".../emby/emby/System/Info/Public" (double-prefix → 404).
   */
  private async checkEmbyPathPrefix(): Promise<boolean> {
    try {
      const baseUrl = (this.axios.defaults.baseURL ?? '')
        .replace(/\/$/, '')
        .replace(/\/emby\/?$/i, '');
      const url = `${baseUrl}/emby/System/Info/Public`;
      logger.debug(`[JellyfinAPI] Method-B probe: GET ${url}`);
      const response = await this.axios.get(url, {
        timeout: 5000,
        validateStatus: () => true,
      });
      logger.debug(`[JellyfinAPI] Method-B probe: status=${response.status}`);
      return response.status >= 200 && response.status < 300;
    } catch {
      return false;
    }
  }

  /**
   * Method E — probe the Jellyfin-only /Startup/Configuration endpoint.
   *
   * Bug 3 fix: tightened from "any non-404" to explicit status checks.
   * A reverse proxy returning 401/403/302/500 was previously mis-classified
   * as Jellyfin. Now:
   *  - 200 + JSON body with known Jellyfin StartupConfiguration fields → true
   *  - 401 → true  (Jellyfin wizard already completed, endpoint exists)
   *  - anything else (302/403/500/etc.) → false
   */
  private async checkJellyfinStartupConfig(): Promise<boolean> {
    try {
      const baseUrl = (this.axios.defaults.baseURL ?? '').replace(/\/$/, '');
      const url = `${baseUrl}/Startup/Configuration`;
      const response = await this.axios.get(url, {
        timeout: 5000,
        validateStatus: () => true,
      });
      logger.debug(
        `[JellyfinAPI] Method-E probe: GET ${url} → status=${response.status}`
      );
      if (response.status === 200) {
        // 200 — verify the JSON body has a Jellyfin StartupConfiguration shape
        const data = response.data as Record<string, unknown> | null;
        const isJellyfinShape =
          data !== null &&
          typeof data === 'object' &&
          ('UICulture' in data ||
            'MetadataCountryCode' in data ||
            'PreferredMetadataLanguage' in data);
        logger.debug(
          `[JellyfinAPI] Method-E probe: 200 body shape check → isJellyfinShape=${String(isJellyfinShape)}`
        );
        return isJellyfinShape;
      }
      if (response.status === 401) {
        // 401 means the Startup wizard is complete on Jellyfin — endpoint exists
        return true;
      }
      // 302/403/500/404/etc. — do not classify as Jellyfin
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Detect whether the configured server is Jellyfin or Emby using a
   * 4-step cascade so detection succeeds even when ProductName is absent
   * (old Emby servers omit that field from /System/Info/Public).
   *
   * A — ProductName field on /System/Info/Public
   * B — /emby/ path-prefix probe (Emby routing middleware only)
   * E — /Startup/Configuration probe (Jellyfin-only wizard endpoint)
   * G — Version string heuristic (4.x → Emby, 10.x → Jellyfin)
   */
  public async getServerProductName(): Promise<'jellyfin' | 'emby' | null> {
    // Method A — ProductName field
    let info: Awaited<ReturnType<typeof this.getServerPublicInfo>> = null;
    try {
      info = await this.getServerPublicInfo();
    } catch {
      // continue to next method
    }

    const name = (info?.productName ?? '').toLowerCase();
    if (name.includes('emby')) {
      logger.debug(
        '[JellyfinAPI] Brand detection: ProductName="' +
          (info?.productName ?? '') +
          '" → method-A match → emby'
      );
      return 'emby';
    }
    if (name.includes('jellyfin')) {
      logger.debug(
        '[JellyfinAPI] Brand detection: ProductName="' +
          (info?.productName ?? '') +
          '" → method-A match → jellyfin'
      );
      return 'jellyfin';
    }

    // Method B — /emby/ path prefix test
    const isEmbyPrefix = await this.checkEmbyPathPrefix();
    if (isEmbyPrefix) {
      logger.debug(
        '[JellyfinAPI] Brand detection: ProductName="" → method-B path /emby/System/Info/Public 200 → emby'
      );
      return 'emby';
    }

    // Method E — /Startup/Configuration (Jellyfin-only)
    const isJellyfinStartup = await this.checkJellyfinStartupConfig();
    if (isJellyfinStartup) {
      logger.debug(
        '[JellyfinAPI] Brand detection: ProductName="" → method-E /Startup/Configuration non-404 → jellyfin'
      );
      return 'jellyfin';
    }

    // Method G — version heuristic (last resort)
    const version = info?.version ?? '';
    if (version.startsWith('4.')) {
      logger.debug(
        `[JellyfinAPI] Brand detection: method-G version="${version}" starts with 4. → emby`
      );
      return 'emby';
    }
    if (version.startsWith('10.')) {
      logger.debug(
        `[JellyfinAPI] Brand detection: method-G version="${version}" starts with 10. → jellyfin`
      );
      return 'jellyfin';
    }

    logger.debug(
      `[JellyfinAPI] Brand detection: all methods exhausted, version="${version}" → null`
    );
    return null;
  }

  public async getUsers(): Promise<JellyfinUserListResponse> {
    try {
      const userReponse = await this.get<JellyfinUserResponse[]>(`/Users`);

      return { users: userReponse };
    } catch (e) {
      logger.error(
        `Something went wrong while getting the account from the Jellyfin server: ${e.message}`,
        { label: 'Jellyfin API', error: e.response?.status }
      );

      throw new ApiError(e.response?.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  public async getUser(): Promise<JellyfinUserResponse> {
    try {
      const userReponse = await this.get<JellyfinUserResponse>(
        `/Users/${this.userId ?? 'Me'}`
      );
      return userReponse;
    } catch (e) {
      logger.error(
        `Something went wrong while getting the account from the Jellyfin server: ${e.message}`,
        { label: 'Jellyfin API', error: e.response?.status }
      );

      throw new ApiError(e.response?.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  public async getLibraries(): Promise<JellyfinLibrary[]> {
    try {
      const mediaFolderResponse = await this.get<any>(`/Library/MediaFolders`);

      return this.mapLibraries(mediaFolderResponse.Items);
    } catch {
      // fallback to user views to get libraries
      // this only and maybe/depending on factors affects LDAP users
      try {
        const mediaFolderResponse = await this.get<any>(
          `/Users/${this.userId ?? 'Me'}/Views`
        );

        return this.mapLibraries(mediaFolderResponse.Items);
      } catch (e) {
        logger.error(
          `Something went wrong while getting libraries from the Jellyfin server: ${e.message}`,
          {
            label: 'Jellyfin API',
            error: e.response?.status,
          }
        );

        return [];
      }
    }
  }

  private mapLibraries(mediaFolders: JellyfinMediaFolder[]): JellyfinLibrary[] {
    const excludedTypes = [
      'music',
      'books',
      'musicvideos',
      'homevideos',
      'boxsets',
    ];

    return mediaFolders
      .filter((Item: JellyfinMediaFolder) => {
        return (
          Item.Type === 'CollectionFolder' &&
          !excludedTypes.includes(Item.CollectionType)
        );
      })
      .map((Item: JellyfinMediaFolder) => {
        return <JellyfinLibrary>{
          key: Item.Id,
          title: Item.Name,
          type: Item.CollectionType === 'movies' ? 'movie' : 'show',
          agent:
            this.mediaServerType === MediaServerType.EMBY ? 'emby' : 'jellyfin',
        };
      });
  }

  public async getLibraryContents(id: string): Promise<JellyfinLibraryItem[]> {
    const isEmby = this.mediaServerType === MediaServerType.EMBY;
    const endpoint = isEmby ? `/Users/${this.userId}/Items` : `/Items`;
    const fetchItems = async (params: Record<string, string>) =>
      this.get<{ Items: JellyfinLibraryItem[] }>(
        this.getRequestPath(endpoint, params)
      );
    const jellyfinParams = {
      SortBy: 'SortName',
      SortOrder: 'Ascending',
      IncludeItemTypes: 'Series,Movie,Others',
      Recursive: 'true',
      StartIndex: '0',
      ParentId: id,
      collapseBoxSetItems: 'false',
    };
    const embyParams = {
      ParentId: id,
      Recursive: 'true',
      IncludeItemTypes: 'Movie,Series',
    };
    const embyFallbackParams = {
      ParentId: id,
    };
    let requestParams: Record<string, string> = isEmby
      ? embyParams
      : jellyfinParams;

    logger.debug('Fetching library contents', {
      label: this.apiLabel,
      libraryId: id,
      requestUrl: this.getRequestPath(endpoint, requestParams),
    });

    try {
      let libraryItemsResponse: { Items: JellyfinLibraryItem[] };

      if (isEmby) {
        try {
          libraryItemsResponse = await fetchItems(embyParams);
        } catch (error) {
          const { status, responseData } = this.getErrorDetails(error);

          if (status !== 500) {
            throw error;
          }

          logger.warn(
            'Emby library content request failed; retrying with minimal query',
            {
              label: this.apiLabel,
              error: status,
              requestUrl: this.getRequestPath(endpoint, embyParams),
              responseData,
            }
          );

          requestParams = embyFallbackParams;
          libraryItemsResponse = await fetchItems(embyFallbackParams);

          logger.info('Emby fallback library query succeeded', {
            label: this.apiLabel,
            libraryId: id,
            requestUrl: this.getRequestPath(endpoint, embyFallbackParams),
            itemCount: libraryItemsResponse.Items.length,
          });
        }
      } else {
        libraryItemsResponse = await fetchItems(jellyfinParams);
      }

      const items = libraryItemsResponse.Items.filter(
        (item: JellyfinLibraryItem) =>
          item.LocationType !== 'Virtual' &&
          (!isEmby || item.Type === 'Movie' || item.Type === 'Series')
      );

      logger.debug('Library contents fetched', {
        label: this.apiLabel,
        libraryId: id,
        rawCount: libraryItemsResponse.Items.length,
        filteredCount: items.length,
      });

      return items;
    } catch (e) {
      const { status, message, responseData } = this.getErrorDetails(e);
      const requestUrl = this.getRequestPath(endpoint, requestParams);

      logger.error(
        `Something went wrong while getting library content from the ${this.apiLabel}: ${message}`,
        { label: this.apiLabel, error: status, requestUrl, responseData }
      );

      const errorCode =
        status === 401 ? ApiErrorCode.InvalidAuthToken : ApiErrorCode.Unknown;
      throw new ApiError(status, errorCode, message, {
        requestUrl,
        responseData,
      });
    }
  }

  public async getRecentlyAdded(id: string): Promise<JellyfinLibraryItem[]> {
    // Jellyfin: /Items/Latest?userId=<id>  (userId in query string)
    // Emby:     /Users/<id>/Items/Latest   (userId in path; no query-string userId param)
    const endpoint =
      this.mediaServerType === MediaServerType.JELLYFIN
        ? `/Items/Latest`
        : `/Users/${this.userId}/Items/Latest`;
    const requestUrl = `${endpoint}?Limit=12&ParentId=${id}${
      this.mediaServerType === MediaServerType.JELLYFIN
        ? `&userId=${this.userId ?? 'Me'}`
        : ''
    }`;

    logger.debug('Fetching recently added items', {
      label: this.apiLabel,
      libraryId: id,
      requestUrl,
    });

    try {
      const itemResponse = await this.get<JellyfinLibraryItem[]>(requestUrl);

      logger.debug('Recently added items fetched', {
        label: this.apiLabel,
        libraryId: id,
        itemCount: itemResponse.length,
      });

      return itemResponse;
    } catch (e) {
      const { status, message, responseData } = this.getErrorDetails(e);
      logger.error(
        `Something went wrong while getting recently added content from the ${this.apiLabel}: ${message}`,
        { label: this.apiLabel, error: status, requestUrl, responseData }
      );

      const errorCode =
        status === 401 ? ApiErrorCode.InvalidAuthToken : ApiErrorCode.Unknown;
      throw new ApiError(status, errorCode, message, {
        requestUrl,
        responseData,
      });
    }
  }

  public async getItemData(
    id: string
  ): Promise<JellyfinLibraryItemExtended | undefined> {
    try {
      const itemResponse = await this.get<JellyfinItemsReponse>(`/Items`, {
        params: {
          ids: id,
          fields: 'ProviderIds,MediaSources,Width,Height,IsHD,DateCreated',
        },
      });

      return itemResponse.Items?.[0];
    } catch (e) {
      if (availabilitySync.running) {
        if (e.response?.status === 500) {
          return undefined;
        }
      }

      logger.error(
        `Something went wrong while getting library content from the Jellyfin server: ${e.message}`,
        { label: 'Jellyfin API', error: e.response?.status }
      );
      throw new ApiError(e.response?.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  public async getSeasons(seriesID: string): Promise<JellyfinLibraryItem[]> {
    try {
      const seasonResponse = await this.get<any>(`/Shows/${seriesID}/Seasons`);

      return seasonResponse.Items;
    } catch (e) {
      logger.error(
        `Something went wrong while getting the list of seasons from the Jellyfin server: ${e.message}`,
        { label: 'Jellyfin API', error: e.response?.status }
      );

      throw new ApiError(e.response?.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  public async getEpisodes<
    T extends { includeMediaInfo?: boolean } | undefined = undefined,
  >(
    seriesID: string,
    seasonID: string,
    options?: T
  ): Promise<EpisodeReturn<T>> {
    try {
      const episodeResponse = await this.get<any>(
        `/Shows/${seriesID}/Episodes`,
        {
          params: {
            seasonId: seasonID,
            ...(options?.includeMediaInfo && { fields: 'MediaSources' }),
          },
        }
      );

      return episodeResponse.Items.filter(
        (item: JellyfinLibraryItem) => item.LocationType !== 'Virtual'
      );
    } catch (e) {
      logger.error(
        `Something went wrong while getting the list of episodes from the Jellyfin server: ${e.message}`,
        { label: 'Jellyfin API', error: e.response?.status }
      );

      throw new ApiError(e.response?.status, ApiErrorCode.InvalidAuthToken);
    }
  }

  public async createApiToken(appName: string): Promise<string> {
    try {
      await this.post(`/Auth/Keys?App=${appName}`);
      const apiKeys = await this.get<any>(`/Auth/Keys`);
      return apiKeys.Items.reverse().find(
        (item: any) => item.AppName === appName
      ).AccessToken;
    } catch (e) {
      logger.error(
        `Something went wrong while creating an API key from the Jellyfin server: ${e.message}`,
        { label: 'Jellyfin API', error: e.response?.status }
      );

      throw new ApiError(e.response?.status, ApiErrorCode.InvalidAuthToken);
    }
  }
}

export default JellyfinAPI;
