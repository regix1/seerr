import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { MediaStatus, MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import { Blocklist } from '@server/entity/Blocklist';
import type { User } from '@server/entity/User';
import { Watchlist } from '@server/entity/Watchlist';
import type { DownloadingItem } from '@server/lib/downloadtracker';
import downloadTracker from '@server/lib/downloadtracker';
import fileFlowsTracker from '@server/lib/fileflows';
import { Permission, Permission2 } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import { getHostname } from '@server/utils/getHostname';
import {
  AfterLoad,
  Column,
  Entity,
  Index,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import Issue from './Issue';
import { MediaRequest } from './MediaRequest';
import Season from './Season';

@Entity()
@Index(['tmdbId', 'mediaType'])
class Media {
  public static async getRelatedMedia(
    user: User | undefined,
    items: { tmdbId: number; mediaType: string }[]
  ): Promise<Media[]> {
    const mediaRepository = getRepository(Media);

    try {
      if (items.length === 0) {
        return [];
      }

      const finalIds = [...new Set(items.map((i) => i.tmdbId))];

      const media = await mediaRepository
        .createQueryBuilder('media')
        .leftJoinAndSelect(
          'media.watchlists',
          'watchlist',
          'media.id= watchlist.media and watchlist.requestedBy = :userId',
          { userId: user?.id }
        ) //,
        .where(' media.tmdbId in (:...finalIds)', { finalIds })
        .getMany();

      return media.filter((m) =>
        items.some((i) => i.tmdbId === m.tmdbId && i.mediaType === m.mediaType)
      );
    } catch (e) {
      logger.error(e.message);
      return [];
    }
  }

  public static async getMedia(
    id: number,
    mediaType: MediaType
  ): Promise<Media | undefined> {
    const mediaRepository = getRepository(Media);

    try {
      const media = await mediaRepository.findOne({
        where: { tmdbId: id, mediaType: mediaType },
        relations: { requests: true, issues: true },
      });

      return media ?? undefined;
    } catch (e) {
      logger.error(e.message);
      return undefined;
    }
  }

  public static async getMediaForUser(
    id: number,
    mediaType: MediaType,
    user?: User
  ): Promise<Media | undefined> {
    const mediaRepository = getRepository(Media);

    try {
      const media = await mediaRepository.findOne({
        where: { tmdbId: id, mediaType: mediaType },
        relations: { requests: true, issues: true },
      });

      if (media) {
        // Strip cross-user `requestedBy` for callers without VIEW_REQUESTER
        // (criterion 32). Owner of a request still sees their own attribution.
        Media.redactRequestersOnList([media], user);
      }
      return media ?? undefined;
    } catch (e) {
      logger.error(e.message);
      return undefined;
    }
  }

  public static async getRelatedMediaForUser(
    user: User | undefined,
    items: { tmdbId: number; mediaType: string }[]
  ): Promise<Media[]> {
    const mediaRepository = getRepository(Media);

    try {
      if (items.length === 0) {
        return [];
      }

      const finalIds = [...new Set(items.map((i) => i.tmdbId))];

      const query = mediaRepository
        .createQueryBuilder('media')
        .leftJoinAndSelect('media.requests', 'requests')
        .leftJoinAndSelect('requests.requestedBy', 'requestedBy')
        .leftJoinAndSelect(
          'media.watchlists',
          'watchlist',
          'media.id = watchlist.media and watchlist.requestedBy = :userId',
          { userId: user?.id }
        )
        .where('media.tmdbId IN (:...finalIds)', { finalIds });

      const media = (await query.getMany()).filter((m) =>
        items.some((i) => i.tmdbId === m.tmdbId && i.mediaType === m.mediaType)
      );

      // Strip cross-user `requestedBy` for callers without VIEW_REQUESTER
      // (criterion 32). Owner of a request still sees their own attribution.
      Media.redactRequestersOnList(media, user);
      return media;
    } catch (e) {
      logger.error(e.message);
      return [];
    }
  }

  /**
   * Strip `requestedBy` from joined media-request rows the viewer is not
   * entitled to see (criterion 32). Mutates each Media's `requests` array
   * in place; the underlying entity remains untouched in the DB.
   *
   * Visibility rule: viewer must have one of
   *   `Permission2.VIEW_REQUESTER` / `Permission.MANAGE_REQUESTS` to see
   * other users' identities.
   * Request owner ALWAYS sees their own attribution.
   */
  public static redactRequestersOnList(
    mediaList: Media[],
    viewer: User | undefined
  ): void {
    if (!mediaList.length) {
      return;
    }
    const canViewAll = !!viewer?.hasPermission(
      [Permission2.VIEW_REQUESTER, Permission.MANAGE_REQUESTS],
      { type: 'or' }
    );
    if (canViewAll) {
      return;
    }
    for (const media of mediaList) {
      if (!media.requests) {
        continue;
      }
      for (const request of media.requests) {
        if (
          request.requestedBy &&
          (!viewer || request.requestedBy.id !== viewer.id)
        ) {
          (request as { requestedBy?: User }).requestedBy = undefined;
        }
      }
    }
  }

  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'varchar' })
  public mediaType: MediaType;

  @Column()
  @Index()
  public tmdbId: number;

  @Column({ unique: true, nullable: true })
  @Index()
  public tvdbId?: number;

  @Column({ nullable: true })
  @Index()
  public imdbId?: string;

  @Column({ type: 'int', default: MediaStatus.UNKNOWN })
  @Index()
  public status: MediaStatus;

  @Column({ type: 'int', default: MediaStatus.UNKNOWN })
  @Index()
  public status4k: MediaStatus;

  @OneToMany(() => MediaRequest, (request) => request.media, {
    cascade: ['insert', 'remove'],
  })
  public requests: MediaRequest[];

  @OneToMany(() => Watchlist, (watchlist) => watchlist.media)
  public watchlists: null | Watchlist[];

  @OneToMany(() => Season, (season) => season.media, {
    cascade: true,
    eager: true,
  })
  public seasons: Season[];

  @OneToMany(() => Issue, (issue) => issue.media, { cascade: true })
  public issues: Issue[];

  @OneToOne(() => Blocklist, (blocklist) => blocklist.media)
  public blocklist: Promise<Blocklist>;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  /**
   * The `lastSeasonChange` column stores the date and time when the media was added to the library.
   * It needs to be database-aware because SQLite supports `datetime` while PostgreSQL supports `timestamp with timezone (timestampz)`.
   */
  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public lastSeasonChange: Date;

  /**
   * The `mediaAddedAt` column stores the date and time when the media was added to the library.
   * It needs to be database-aware because SQLite supports `datetime` while PostgreSQL supports `timestamp with timezone (timestampz)`.
   * This column is nullable because it can be null when the media is not yet synced to the library.
   */
  @DbAwareColumn({
    type: 'datetime',
    default: () => 'CURRENT_TIMESTAMP',
    nullable: true,
  })
  public mediaAddedAt: Date;

  @Column({ nullable: true, type: 'int' })
  public serviceId?: number | null;

  @Column({ nullable: true, type: 'int' })
  public serviceId4k?: number | null;

  @Column({ nullable: true, type: 'int' })
  public externalServiceId?: number | null;

  @Column({ nullable: true, type: 'int' })
  public externalServiceId4k?: number | null;

  @Column({ nullable: true, type: 'varchar' })
  public externalServiceSlug?: string | null;

  @Column({ nullable: true, type: 'varchar' })
  public externalServiceSlug4k?: string | null;

  @Column({ nullable: true, type: 'varchar' })
  public ratingKey?: string | null;

  @Column({ nullable: true, type: 'varchar' })
  public ratingKey4k?: string | null;

  @Column({ nullable: true, type: 'varchar' })
  public jellyfinMediaId?: string | null;

  @Column({ nullable: true, type: 'varchar' })
  public jellyfinMediaId4k?: string | null;

  @Column({ nullable: true, type: 'varchar' })
  public embyMediaId?: string | null;

  @Column({ nullable: true, type: 'varchar' })
  public embyMediaId4k?: string | null;

  public serviceUrl?: string;
  public serviceUrl4k?: string;
  public downloadStatus?: DownloadingItem[] = [];
  public downloadStatus4k?: DownloadingItem[] = [];
  public fileFlowsProcessing?: boolean = false;
  public fileFlowsProgress?: number | null = null;
  public fileFlowsStep?: string | null = null;

  public mediaUrl?: string;
  public mediaUrl4k?: string;

  public jellyfinMediaUrl?: string;
  public jellyfinMediaUrl4k?: string;

  public embyMediaUrl?: string;
  public embyMediaUrl4k?: string;

  public iOSPlexUrl?: string;
  public iOSPlexUrl4k?: string;

  public tautulliUrl?: string;
  public tautulliUrl4k?: string;

  constructor(init?: Partial<Media>) {
    Object.assign(this, init);
  }

  public resetServiceData(): void {
    this.serviceId = null;
    this.serviceId4k = null;
    this.externalServiceId = null;
    this.externalServiceId4k = null;
    this.externalServiceSlug = null;
    this.externalServiceSlug4k = null;
    this.ratingKey = null;
    this.ratingKey4k = null;
    this.jellyfinMediaId = null;
    this.jellyfinMediaId4k = null;
    this.embyMediaId = null;
    this.embyMediaId4k = null;
  }

  @AfterLoad()
  public setPlexUrls(): void {
    const { machineId, webAppUrl } = getSettings().plex;
    const { externalUrl: tautulliUrl } = getSettings().tautulli;

    if (this.ratingKey) {
      this.mediaUrl = `${
        webAppUrl ? webAppUrl : 'https://app.plex.tv/desktop'
      }#!/server/${machineId}/details?key=%2Flibrary%2Fmetadata%2F${
        this.ratingKey
      }`;

      this.iOSPlexUrl = `plex://preplay/?metadataKey=%2Flibrary%2Fmetadata%2F${this.ratingKey}&server=${machineId}`;

      if (tautulliUrl) {
        this.tautulliUrl = `${tautulliUrl}/info?rating_key=${this.ratingKey}`;
      }
    }

    if (this.ratingKey4k) {
      this.mediaUrl4k = `${
        webAppUrl ? webAppUrl : 'https://app.plex.tv/desktop'
      }#!/server/${machineId}/details?key=%2Flibrary%2Fmetadata%2F${
        this.ratingKey4k
      }`;

      this.iOSPlexUrl4k = `plex://preplay/?metadataKey=%2Flibrary%2Fmetadata%2F${this.ratingKey4k}&server=${machineId}`;

      if (tautulliUrl) {
        this.tautulliUrl4k = `${tautulliUrl}/info?rating_key=${this.ratingKey4k}`;
      }
    }

    // Always compute Jellyfin URLs when Jellyfin fields are present,
    // regardless of which server is the primary mediaServerType.
    // This allows both mediaUrl (Plex) and jellyfinMediaUrl (Jellyfin)
    // to be non-null simultaneously on the same media row.
    if (this.jellyfinMediaId || this.jellyfinMediaId4k) {
      const pageName = 'details';
      const { serverId, externalHostname } = getSettings().jellyfin;
      const jellyfinHost =
        externalHostname && externalHostname.length > 0
          ? externalHostname
          : getHostname();

      if (this.jellyfinMediaId) {
        const jellyfinUrl = `${jellyfinHost}/web/index.html#!/${pageName}?id=${this.jellyfinMediaId}&context=home&serverId=${serverId}`;
        this.jellyfinMediaUrl = jellyfinUrl;
        // Backward compat: also populate mediaUrl when Plex is not the primary
        // server (single-Jellyfin/Emby installs expect mediaUrl to be set).
        if (
          getSettings().main.mediaServerType !== MediaServerType.PLEX &&
          !this.mediaUrl
        ) {
          this.mediaUrl = jellyfinUrl;
        }
      }
      if (this.jellyfinMediaId4k) {
        const jellyfinUrl4k = `${jellyfinHost}/web/index.html#!/${pageName}?id=${this.jellyfinMediaId4k}&context=home&serverId=${serverId}`;
        this.jellyfinMediaUrl4k = jellyfinUrl4k;
        // Backward compat: also populate mediaUrl4k when Plex is not the primary server.
        if (
          getSettings().main.mediaServerType !== MediaServerType.PLEX &&
          !this.mediaUrl4k
        ) {
          this.mediaUrl4k = jellyfinUrl4k;
        }
      }
    }

    if (this.embyMediaId || this.embyMediaId4k) {
      const { serverId, externalHostname } = getSettings().emby;
      const embyHost =
        externalHostname && externalHostname.length > 0
          ? externalHostname
          : getHostname(getSettings().emby);

      if (this.embyMediaId) {
        const embyUrl = `${embyHost}/web/index.html#!/item?id=${this.embyMediaId}&context=home&serverId=${serverId}`;
        this.embyMediaUrl = embyUrl;
        if (
          getSettings().main.mediaServerType === MediaServerType.EMBY &&
          !this.mediaUrl
        ) {
          this.mediaUrl = embyUrl;
        }
      }

      if (this.embyMediaId4k) {
        const embyUrl4k = `${embyHost}/web/index.html#!/item?id=${this.embyMediaId4k}&context=home&serverId=${serverId}`;
        this.embyMediaUrl4k = embyUrl4k;
        if (
          getSettings().main.mediaServerType === MediaServerType.EMBY &&
          !this.mediaUrl4k
        ) {
          this.mediaUrl4k = embyUrl4k;
        }
      }
    }
  }

  @AfterLoad()
  public setServiceUrl(): void {
    if (this.mediaType === MediaType.MOVIE) {
      if (this.serviceId !== null && this.externalServiceSlug !== null) {
        const settings = getSettings();
        const server = settings.radarr.find(
          (radarr) => radarr.id === this.serviceId
        );

        if (server) {
          this.serviceUrl = server.externalUrl
            ? `${server.externalUrl}/movie/${this.externalServiceSlug}`
            : RadarrAPI.buildUrl(server, `/movie/${this.externalServiceSlug}`);
        }
      }

      if (this.serviceId4k !== null && this.externalServiceSlug4k !== null) {
        const settings = getSettings();
        const server = settings.radarr.find(
          (radarr) => radarr.id === this.serviceId4k
        );

        if (server) {
          this.serviceUrl4k = server.externalUrl
            ? `${server.externalUrl}/movie/${this.externalServiceSlug4k}`
            : RadarrAPI.buildUrl(
                server,
                `/movie/${this.externalServiceSlug4k}`
              );
        }
      }
    }

    if (this.mediaType === MediaType.TV) {
      if (this.serviceId !== null && this.externalServiceSlug !== null) {
        const settings = getSettings();
        const server = settings.sonarr.find(
          (sonarr) => sonarr.id === this.serviceId
        );

        if (server) {
          this.serviceUrl = server.externalUrl
            ? `${server.externalUrl}/series/${this.externalServiceSlug}`
            : SonarrAPI.buildUrl(server, `/series/${this.externalServiceSlug}`);
        }
      }

      if (this.serviceId4k !== null && this.externalServiceSlug4k !== null) {
        const settings = getSettings();
        const server = settings.sonarr.find(
          (sonarr) => sonarr.id === this.serviceId4k
        );

        if (server) {
          this.serviceUrl4k = server.externalUrl
            ? `${server.externalUrl}/series/${this.externalServiceSlug4k}`
            : SonarrAPI.buildUrl(
                server,
                `/series/${this.externalServiceSlug4k}`
              );
        }
      }
    }
  }

  @AfterLoad()
  public getDownloadingItem(): void {
    if (this.mediaType === MediaType.MOVIE) {
      if (
        this.externalServiceId !== undefined &&
        this.externalServiceId !== null &&
        this.serviceId !== undefined &&
        this.serviceId !== null
      ) {
        this.downloadStatus = downloadTracker.getMovieProgress(
          this.serviceId,
          this.externalServiceId
        );
      }

      if (
        this.externalServiceId4k !== undefined &&
        this.externalServiceId4k !== null &&
        this.serviceId4k !== undefined &&
        this.serviceId4k !== null
      ) {
        this.downloadStatus4k = downloadTracker.getMovieProgress(
          this.serviceId4k,
          this.externalServiceId4k
        );
      }
    }

    if (this.mediaType === MediaType.TV) {
      if (
        this.externalServiceId !== undefined &&
        this.externalServiceId !== null &&
        this.serviceId !== undefined &&
        this.serviceId !== null
      ) {
        this.downloadStatus = downloadTracker.getSeriesProgress(
          this.serviceId,
          this.externalServiceId
        );
      }

      if (
        this.externalServiceId4k !== undefined &&
        this.externalServiceId4k !== null &&
        this.serviceId4k !== undefined &&
        this.serviceId4k !== null
      ) {
        this.downloadStatus4k = downloadTracker.getSeriesProgress(
          this.serviceId4k,
          this.externalServiceId4k
        );
      }
    }

    const fileFlowsKeys =
      this.mediaType === MediaType.MOVIE
        ? [
            `tmdb:${this.tmdbId}`,
            this.externalServiceId != null
              ? `radarr:${this.externalServiceId}`
              : undefined,
            this.externalServiceId4k != null
              ? `radarr:${this.externalServiceId4k}`
              : undefined,
          ]
        : [
            // The resolver holds series under the Sonarr `tvdb:` key (and the
            // download tracker under `sonarr:`); `tmdb:` is a defensive fallback
            // for any future TMDB-keyed TV hold (it carries no live percent).
            this.tvdbId != null ? `tvdb:${this.tvdbId}` : undefined,
            this.tmdbId != null ? `tmdb:${this.tmdbId}` : undefined,
            this.externalServiceId != null
              ? `sonarr:${this.externalServiceId}`
              : undefined,
            this.externalServiceId4k != null
              ? `sonarr:${this.externalServiceId4k}`
              : undefined,
          ];
    this.fileFlowsProcessing = fileFlowsTracker.isHeld(...fileFlowsKeys);
    this.fileFlowsProgress = fileFlowsTracker.getHeldProgress(...fileFlowsKeys);
    this.fileFlowsStep = fileFlowsTracker.getHeldStep(...fileFlowsKeys);

    // Per-season FileFlows state (the resolver holds TV at season granularity
    // under `tvdb:<id>:s<n>`), surfaced on mediaInfo.seasons[] for the season
    // group / overall badge on the details page.
    if (this.mediaType === MediaType.TV && Array.isArray(this.seasons)) {
      for (const season of this.seasons) {
        const seasonKeys = [
          this.tvdbId != null
            ? `tvdb:${this.tvdbId}:s${season.seasonNumber}`
            : undefined,
          this.tmdbId != null
            ? `tmdb:${this.tmdbId}:s${season.seasonNumber}`
            : undefined,
        ];
        season.fileFlowsProcessing = fileFlowsTracker.isHeld(...seasonKeys);
        season.fileFlowsProgress = fileFlowsTracker.getHeldProgress(
          ...seasonKeys
        );
        season.fileFlowsStep = fileFlowsTracker.getHeldStep(...seasonKeys);
      }
    }
  }
}

export default Media;
