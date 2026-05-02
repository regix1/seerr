import type { JellyfinLibraryItem } from '@server/api/jellyfin';
import JellyfinAPI from '@server/api/jellyfin';
import type { PlexMetadata } from '@server/api/plexapi';
import PlexAPI from '@server/api/plexapi';
import RadarrAPI, { type RadarrMovie } from '@server/api/servarr/radarr';
import type { SonarrSeason, SonarrSeries } from '@server/api/servarr/sonarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MediaRequest from '@server/entity/MediaRequest';
import type Season from '@server/entity/Season';
import { User } from '@server/entity/User';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';

class AvailabilitySync {
  public running = false;
  private plexClient?: PlexAPI;
  private plexSeasonsCache: Record<string, PlexMetadata[]>;

  private jellyfinClient?: JellyfinAPI;
  private jellyfinSeasonsCache: Record<string, JellyfinLibraryItem[]>;

  private embyClient?: JellyfinAPI;
  private embySeasonsCache: Record<string, JellyfinLibraryItem[]>;

  private sonarrSeasonsCache: Record<string, SonarrSeason[]>;
  private radarrServers: RadarrSettings[];
  private sonarrServers: SonarrSettings[];

  async run() {
    const settings = getSettings();
    const {
      mediaServerType,
      plexLoginEnabled,
      jellyfinLoginEnabled,
      embyLoginEnabled,
    } = settings.main;
    this.running = true;
    this.plexClient = undefined;
    this.jellyfinClient = undefined;
    this.embyClient = undefined;
    this.plexSeasonsCache = {};
    this.jellyfinSeasonsCache = {};
    this.embySeasonsCache = {};
    this.sonarrSeasonsCache = {};
    this.radarrServers = settings.radarr.filter((server) => server.syncEnabled);
    this.sonarrServers = settings.sonarr.filter((server) => server.syncEnabled);

    try {
      logger.info(`Starting availability sync...`, {
        label: 'Availability Sync',
      });
      const pageSize = 50;

      const userRepository = getRepository(User);

      // Build plexClient independently when plexLoginEnabled and plex hostname is configured
      if (plexLoginEnabled || mediaServerType === MediaServerType.PLEX) {
        const plexAdmin = await userRepository.findOne({
          select: { id: true, plexToken: true },
          where: { id: 1 },
        });

        if (plexAdmin && plexAdmin.plexToken && settings.plex.ip) {
          this.plexClient = new PlexAPI({ plexToken: plexAdmin.plexToken });
          logger.info('Plex: running', { label: 'AvailabilitySync' });
        } else {
          logger.warn(
            'Plex client not initialized: admin token or hostname missing.',
            {
              label: 'AvailabilitySync',
            }
          );
        }
      }

      // Build jellyfinClient independently when jellyfinLoginEnabled and jellyfin hostname is configured
      if (
        jellyfinLoginEnabled ||
        mediaServerType === MediaServerType.JELLYFIN
      ) {
        if (settings.jellyfin.ip && settings.jellyfin.apiKey) {
          const jellyfinAdmin = await userRepository.findOne({
            where: { id: 1 },
            select: ['id', 'jellyfinUserId', 'jellyfinDeviceId'],
            order: { id: 'ASC' },
          });

          if (jellyfinAdmin) {
            this.jellyfinClient = JellyfinAPI.forJellyfin(
              settings.jellyfin,
              settings.jellyfin.apiKey,
              jellyfinAdmin.jellyfinDeviceId
            );

            this.jellyfinClient.setUserId(jellyfinAdmin.jellyfinUserId ?? '');

            try {
              await this.jellyfinClient.getSystemInfo();
              logger.info('Jellyfin: running', { label: 'AvailabilitySync' });
            } catch (e) {
              logger.error('Jellyfin sync initialization interrupted.', {
                label: 'AvailabilitySync',
                status: e.statusCode,
                error: e.name,
                errorMessage: e.errorCode,
              });
              this.jellyfinClient = undefined;
            }
          } else {
            logger.warn('Jellyfin admin is not configured.', {
              label: 'AvailabilitySync',
            });
          }
        }
      }

      // Build embyClient independently when embyLoginEnabled and emby hostname is configured
      if (embyLoginEnabled || mediaServerType === MediaServerType.EMBY) {
        if (settings.emby.ip && settings.emby.apiKey) {
          const embyAdmin = await userRepository.findOne({
            where: { id: 1 },
            select: ['id', 'embyUserId', 'embyDeviceId'],
            order: { id: 'ASC' },
          });

          if (embyAdmin) {
            this.embyClient = JellyfinAPI.forEmby(
              settings.emby,
              settings.emby.apiKey,
              embyAdmin.embyDeviceId
            );

            this.embyClient.setUserId(embyAdmin.embyUserId ?? '');

            try {
              await this.embyClient.getSystemInfo();
              logger.info('Emby: running', { label: 'AvailabilitySync' });
            } catch (e) {
              logger.error('Emby sync initialization interrupted.', {
                label: 'AvailabilitySync',
                status: e.statusCode,
                error: e.name,
                errorMessage: e.errorCode,
              });
              this.embyClient = undefined;
            }
          } else {
            logger.warn('Emby admin is not configured.', {
              label: 'AvailabilitySync',
            });
          }
        }
      }

      // If no clients are available, abort
      if (!this.plexClient && !this.jellyfinClient && !this.embyClient) {
        logger.error(
          'No media server client could be initialized. Aborting availability sync.',
          {
            label: 'AvailabilitySync',
          }
        );
        this.running = false;
        return;
      }

      for await (const media of this.loadAvailableMediaPaginated(pageSize)) {
        if (!this.running) {
          throw new Error('Job aborted');
        }

        // Check plex, radarr, and sonarr for that specific media and
        // if unavailable, then we change the status accordingly.
        // If a non-4k or 4k version exists in at least one of the instances, we will only update that specific version
        if (media.mediaType === 'movie') {
          let movieExists = false;
          let movieExists4k = false;

          const existsInRadarr = await this.mediaExistsInRadarr(media, false);
          const existsInRadarr4k = await this.mediaExistsInRadarr(media, true);

          // plex — runs independently when plexClient is available
          if (this.plexClient) {
            const { existsInPlex } = await this.mediaExistsInPlex(media, false);
            const { existsInPlex: existsInPlex4k } =
              await this.mediaExistsInPlex(media, true);

            if (existsInPlex || existsInRadarr) {
              movieExists = true;
              logger.info(
                `The non-4K movie [TMDB ID ${media.tmdbId}] still exists. Preventing removal.`,
                {
                  label: 'AvailabilitySync',
                }
              );
            }

            if (existsInPlex4k || existsInRadarr4k) {
              movieExists4k = true;
              logger.info(
                `The 4K movie [TMDB ID ${media.tmdbId}] still exists. Preventing removal.`,
                {
                  label: 'AvailabilitySync',
                }
              );
            }
          }

          // jellyfin — runs independently when jellyfinClient is available
          if (this.jellyfinClient) {
            const { existsInJellyfin } = await this.mediaExistsInJellyfin(
              media,
              false
            );
            const { existsInJellyfin: existsInJellyfin4k } =
              await this.mediaExistsInJellyfin(media, true);

            if (existsInJellyfin || existsInRadarr) {
              movieExists = true;
              logger.info(
                `The non-4K movie [TMDB ID ${media.tmdbId}] still exists. Preventing removal.`,
                {
                  label: 'AvailabilitySync',
                }
              );
            }

            if (existsInJellyfin4k || existsInRadarr4k) {
              movieExists4k = true;
              logger.info(
                `The 4K movie [TMDB ID ${media.tmdbId}] still exists. Preventing removal.`,
                {
                  label: 'AvailabilitySync',
                }
              );
            }
          }

          // emby — runs independently when embyClient is available
          if (this.embyClient) {
            const { existsInEmby } = await this.mediaExistsInEmby(media, false);
            const { existsInEmby: existsInEmby4k } =
              await this.mediaExistsInEmby(media, true);

            if (existsInEmby || existsInRadarr) {
              movieExists = true;
              logger.info(
                `The non-4K movie [TMDB ID ${media.tmdbId}] still exists. Preventing removal.`,
                {
                  label: 'AvailabilitySync',
                }
              );
            }

            if (existsInEmby4k || existsInRadarr4k) {
              movieExists4k = true;
              logger.info(
                `The 4K movie [TMDB ID ${media.tmdbId}] still exists. Preventing removal.`,
                {
                  label: 'AvailabilitySync',
                }
              );
            }
          }

          if (!movieExists && media.status === MediaStatus.AVAILABLE) {
            await this.mediaUpdater(media, false);
          }

          if (!movieExists4k && media.status4k === MediaStatus.AVAILABLE) {
            await this.mediaUpdater(media, true);
          }
        }

        // If both versions still exist in plex, we still need
        // to check through sonarr to verify season availability
        if (media.mediaType === 'tv') {
          let showExists = false;
          let showExists4k = false;

          // Sonarr is checked first so plex/jellyfin/emby blocks can reference its results
          const { existsInSonarr, seasonsMap: sonarrSeasonsMap } =
            await this.mediaExistsInSonarr(media, false);
          const {
            existsInSonarr: existsInSonarr4k,
            seasonsMap: sonarrSeasonsMap4k,
          } = await this.mediaExistsInSonarr(media, true);

          // plex — run independently when plexClient is available
          let plexSeasonsMap: Map<number, boolean> = new Map();
          let plexSeasonsMap4k: Map<number, boolean> = new Map();

          if (this.plexClient) {
            const plexResult = await this.mediaExistsInPlex(media, false);
            const existsInPlex = plexResult.existsInPlex;
            plexSeasonsMap = plexResult.seasonsMap ?? new Map();

            const plexResult4k = await this.mediaExistsInPlex(media, true);
            const existsInPlex4k = plexResult4k.existsInPlex;
            plexSeasonsMap4k = plexResult4k.seasonsMap ?? new Map();

            if (existsInPlex || existsInSonarr) {
              showExists = true;
              logger.info(
                `The non-4K show [TMDB ID ${media.tmdbId}] still exists. Preventing removal.`,
                {
                  label: 'AvailabilitySync',
                }
              );
            }

            if (existsInPlex4k || existsInSonarr4k) {
              showExists4k = true;
              logger.info(
                `The 4K show [TMDB ID ${media.tmdbId}] still exists. Preventing removal.`,
                {
                  label: 'AvailabilitySync',
                }
              );
            }
          }

          // jellyfin — run independently when jellyfinClient is available
          let jellyfinSeasonsMap: Map<number, boolean> = new Map();
          let jellyfinSeasonsMap4k: Map<number, boolean> = new Map();

          if (this.jellyfinClient) {
            const jellyfinResult = await this.mediaExistsInJellyfin(
              media,
              false
            );
            const existsInJellyfin = jellyfinResult.existsInJellyfin;
            jellyfinSeasonsMap = jellyfinResult.seasonsMap ?? new Map();

            const jellyfinResult4k = await this.mediaExistsInJellyfin(
              media,
              true
            );
            const existsInJellyfin4k = jellyfinResult4k.existsInJellyfin;
            jellyfinSeasonsMap4k = jellyfinResult4k.seasonsMap ?? new Map();

            if (existsInJellyfin || existsInSonarr) {
              showExists = true;
              logger.info(
                `The non-4K show [TMDB ID ${media.tmdbId}] still exists. Preventing removal.`,
                {
                  label: 'AvailabilitySync',
                }
              );
            }

            if (existsInJellyfin4k || existsInSonarr4k) {
              showExists4k = true;
              logger.info(
                `The 4K show [TMDB ID ${media.tmdbId}] still exists. Preventing removal.`,
                {
                  label: 'AvailabilitySync',
                }
              );
            }
          }

          // emby — run independently when embyClient is available
          let embySeasonsMap: Map<number, boolean> = new Map();
          let embySeasonsMap4k: Map<number, boolean> = new Map();

          if (this.embyClient) {
            const embyResult = await this.mediaExistsInEmby(media, false);
            const existsInEmby = embyResult.existsInEmby;
            embySeasonsMap = embyResult.seasonsMap ?? new Map();

            const embyResult4k = await this.mediaExistsInEmby(media, true);
            const existsInEmby4k = embyResult4k.existsInEmby;
            embySeasonsMap4k = embyResult4k.seasonsMap ?? new Map();

            if (existsInEmby || existsInSonarr) {
              showExists = true;
              logger.info(
                `The non-4K show [TMDB ID ${media.tmdbId}] still exists. Preventing removal.`,
                {
                  label: 'AvailabilitySync',
                }
              );
            }

            if (existsInEmby4k || existsInSonarr4k) {
              showExists4k = true;
              logger.info(
                `The 4K show [TMDB ID ${media.tmdbId}] still exists. Preventing removal.`,
                {
                  label: 'AvailabilitySync',
                }
              );
            }
          }

          // Here we will create a final map that will cross compare
          // with plex, jellyfin, emby, and sonarr. Filtered seasons will go through
          // each season and assume the season does not exist. If any server or
          // Sonarr finds that season, we will change the final seasons value
          // to true.
          const filteredSeasonsMap: Map<number, boolean> = new Map();
          media.seasons
            .filter(
              (season) =>
                season.status === MediaStatus.AVAILABLE ||
                season.status === MediaStatus.PARTIALLY_AVAILABLE
            )
            .forEach((season) =>
              filteredSeasonsMap.set(season.seasonNumber, false)
            );

          const filteredSeasonsMap4k: Map<number, boolean> = new Map();
          media.seasons
            .filter(
              (season) =>
                season.status4k === MediaStatus.AVAILABLE ||
                season.status4k === MediaStatus.PARTIALLY_AVAILABLE
            )
            .forEach((season) =>
              filteredSeasonsMap4k.set(season.seasonNumber, false)
            );

          // Merge all sources: plex + jellyfin + emby + sonarr (each runs when its client is present)
          const finalSeasons = new Map([
            ...filteredSeasonsMap,
            ...plexSeasonsMap,
            ...jellyfinSeasonsMap,
            ...embySeasonsMap,
            ...sonarrSeasonsMap,
          ]);
          const finalSeasons4k = new Map([
            ...filteredSeasonsMap4k,
            ...plexSeasonsMap4k,
            ...jellyfinSeasonsMap4k,
            ...embySeasonsMap4k,
            ...sonarrSeasonsMap4k,
          ]);

          if (
            !showExists &&
            (media.status === MediaStatus.AVAILABLE ||
              media.status === MediaStatus.PARTIALLY_AVAILABLE ||
              media.seasons.some(
                (season) => season.status === MediaStatus.AVAILABLE
              ) ||
              media.seasons.some(
                (season) => season.status === MediaStatus.PARTIALLY_AVAILABLE
              ))
          ) {
            await this.mediaUpdater(media, false);
          }

          if (
            !showExists4k &&
            (media.status4k === MediaStatus.AVAILABLE ||
              media.status4k === MediaStatus.PARTIALLY_AVAILABLE ||
              media.seasons.some(
                (season) => season.status4k === MediaStatus.AVAILABLE
              ) ||
              media.seasons.some(
                (season) => season.status4k === MediaStatus.PARTIALLY_AVAILABLE
              ))
          ) {
            await this.mediaUpdater(media, true);
          }

          // TODO: Figure out how to run seasonUpdater for each season

          if ([...finalSeasons.values()].includes(false)) {
            await this.seasonUpdater(media, finalSeasons, false);
          }

          if ([...finalSeasons4k.values()].includes(false)) {
            await this.seasonUpdater(media, finalSeasons4k, true);
          }
        }
      }
    } catch (ex) {
      logger.error('Failed to complete availability sync.', {
        errorMessage: ex.message,
        label: 'Availability Sync',
      });
    } finally {
      if (this.plexClient) {
        logger.info('Plex: done', { label: 'AvailabilitySync' });
      }
      if (this.jellyfinClient) {
        logger.info('Jellyfin: done', { label: 'AvailabilitySync' });
      }
      if (this.embyClient) {
        logger.info('Emby: done', { label: 'AvailabilitySync' });
      }
      logger.info(`Availability sync complete.`, {
        label: 'Availability Sync',
      });
      this.running = false;
    }
  }

  public cancel() {
    this.running = false;
  }

  private async *loadAvailableMediaPaginated(pageSize: number) {
    let offset = 0;
    const mediaRepository = getRepository(Media);
    const whereOptions = [
      { status: MediaStatus.AVAILABLE },
      { status: MediaStatus.PARTIALLY_AVAILABLE },
      { status4k: MediaStatus.AVAILABLE },
      { status4k: MediaStatus.PARTIALLY_AVAILABLE },
      { seasons: { status: MediaStatus.AVAILABLE } },
      { seasons: { status: MediaStatus.PARTIALLY_AVAILABLE } },
      { seasons: { status4k: MediaStatus.AVAILABLE } },
      { seasons: { status4k: MediaStatus.PARTIALLY_AVAILABLE } },
    ];

    let mediaPage: Media[];

    do {
      yield* (mediaPage = await mediaRepository.find({
        where: whereOptions,
        skip: offset,
        take: pageSize,
      }));
      offset += pageSize;
    } while (mediaPage.length > 0);
  }

  private async mediaUpdater(media: Media, is4k: boolean): Promise<void> {
    const mediaRepository = getRepository(Media);

    try {
      // If media type is tv, check if a season is processing
      // to see if we need to keep the external metadata
      let isMediaProcessing = false;

      if (media.mediaType === 'tv') {
        const requestRepository = getRepository(MediaRequest);

        const request = await requestRepository
          .createQueryBuilder('request')
          .leftJoinAndSelect('request.media', 'media')
          .where('(media.id = :id)', {
            id: media.id,
          })
          .andWhere(
            '(request.is4k = :is4k AND request.status = :requestStatus)',
            {
              requestStatus: MediaRequestStatus.APPROVED,
              is4k: is4k,
            }
          )
          .getOne();

        if (request) {
          isMediaProcessing = true;
        }
      }

      // Set the non-4K or 4K media to deleted
      // and change related columns to null if media
      // is not processing
      media[is4k ? 'status4k' : 'status'] = MediaStatus.DELETED;
      media[is4k ? 'serviceId4k' : 'serviceId'] = isMediaProcessing
        ? media[is4k ? 'serviceId4k' : 'serviceId']
        : null;
      media[is4k ? 'externalServiceId4k' : 'externalServiceId'] =
        isMediaProcessing
          ? media[is4k ? 'externalServiceId4k' : 'externalServiceId']
          : null;
      media[is4k ? 'externalServiceSlug4k' : 'externalServiceSlug'] =
        isMediaProcessing
          ? media[is4k ? 'externalServiceSlug4k' : 'externalServiceSlug']
          : null;

      // Clear plex media-id field only when the plex client was active (i.e. checked plex)
      if (this.plexClient) {
        media[is4k ? 'ratingKey4k' : 'ratingKey'] = isMediaProcessing
          ? media[is4k ? 'ratingKey4k' : 'ratingKey']
          : null;
      }

      // Clear jellyfin media-id field only when the jellyfin client was active (i.e. checked jellyfin)
      if (this.jellyfinClient) {
        media[is4k ? 'jellyfinMediaId4k' : 'jellyfinMediaId'] =
          isMediaProcessing
            ? media[is4k ? 'jellyfinMediaId4k' : 'jellyfinMediaId']
            : null;
      }

      // Clear emby media-id field only when the emby client was active (i.e. checked emby)
      if (this.embyClient) {
        media[is4k ? 'embyMediaId4k' : 'embyMediaId'] = isMediaProcessing
          ? media[is4k ? 'embyMediaId4k' : 'embyMediaId']
          : null;
      }

      // Derive the server name(s) that were checked for logging
      const checkedServers = [
        this.plexClient ? 'plex' : null,
        this.jellyfinClient ? 'jellyfin' : null,
        this.embyClient ? 'emby' : null,
      ]
        .filter(Boolean)
        .join(' and ');

      logger.info(
        `The ${is4k ? '4K' : 'non-4K'} ${
          media.mediaType === 'movie' ? 'movie' : 'show'
        } [TMDB ID ${media.tmdbId}] was not found in any ${
          media.mediaType === 'movie' ? 'Radarr' : 'Sonarr'
        } and ${checkedServers} instance. Status will be changed to deleted.`,
        { label: 'AvailabilitySync' }
      );

      await mediaRepository.save(media);
    } catch (ex) {
      logger.debug(
        `Failure updating the ${is4k ? '4K' : 'non-4K'} ${
          media.mediaType === 'tv' ? 'show' : 'movie'
        } [TMDB ID ${media.tmdbId}].`,
        {
          errorMessage: ex.message,
          label: 'Availability Sync',
        }
      );
    }
  }

  private async seasonUpdater(
    media: Media,
    seasons: Map<number, boolean>,
    is4k: boolean
  ): Promise<void> {
    const mediaRepository = getRepository(Media);

    // Filter out only the values that are false
    // (media that should be deleted)
    const seasonsPendingRemoval = new Map(
      // Disabled linter as only the value is needed from the filter
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      [...seasons].filter(([_, exists]) => !exists)
    );
    // Retrieve the season keys to pass into our log
    const seasonKeys = [...seasonsPendingRemoval.keys()];

    // let isSeasonRemoved = false;

    try {
      for (const mediaSeason of media.seasons) {
        if (seasonsPendingRemoval.has(mediaSeason.seasonNumber)) {
          mediaSeason[is4k ? 'status4k' : 'status'] = MediaStatus.DELETED;
        }
      }

      if (media.status === MediaStatus.AVAILABLE && !is4k) {
        media.status = MediaStatus.PARTIALLY_AVAILABLE;
        logger.info(
          `Marking the non-4K show [TMDB ID ${media.tmdbId}] as PARTIALLY_AVAILABLE because season removal has occurred.`,
          { label: 'Availability Sync' }
        );
      }

      if (media.status4k === MediaStatus.AVAILABLE && is4k) {
        media.status4k = MediaStatus.PARTIALLY_AVAILABLE;
        logger.info(
          `Marking the 4K show [TMDB ID ${media.tmdbId}] as PARTIALLY_AVAILABLE because season removal has occurred.`,
          { label: 'Availability Sync' }
        );
      }

      media.lastSeasonChange = new Date();
      await mediaRepository.save(media);

      // Derive the server name(s) that were checked for logging
      const checkedServers = [
        this.plexClient ? 'plex' : null,
        this.jellyfinClient ? 'jellyfin' : null,
        this.embyClient ? 'emby' : null,
      ]
        .filter(Boolean)
        .join(' and ');

      logger.info(
        `The ${is4k ? '4K' : 'non-4K'} season(s) [${seasonKeys}] [TMDB ID ${
          media.tmdbId
        }] was not found in any ${
          media.mediaType === 'tv' ? 'Sonarr' : 'Radarr'
        } and ${checkedServers} instance. Status will be changed to deleted.`,
        { label: 'AvailabilitySync' }
      );
    } catch (ex) {
      logger.debug(
        `Failure updating the ${
          is4k ? '4K' : 'non-4K'
        } season(s) [${seasonKeys}], TMDB ID ${media.tmdbId}.`,
        {
          errorMessage: ex.message,
          label: 'Availability Sync',
        }
      );
    }
  }

  private async mediaExistsInRadarr(
    media: Media,
    is4k: boolean
  ): Promise<boolean> {
    let existsInRadarr = false;

    const hasSameServerInBothModes = this.radarrServers.some((a) =>
      this.radarrServers.some(
        (b) =>
          a.is4k !== b.is4k && a.hostname === b.hostname && a.port === b.port
      )
    );

    // Check for availability in all of the available radarr servers
    // If any find the media, we will assume the media exists
    for (const server of this.radarrServers.filter(
      (server) => server.is4k === is4k
    )) {
      const radarrAPI = new RadarrAPI({
        apiKey: server.apiKey,
        url: RadarrAPI.buildUrl(server, '/api/v3'),
      });

      try {
        let radarr: RadarrMovie | undefined;

        if (media.externalServiceId && !is4k) {
          radarr = await radarrAPI.getMovie({
            id: media.externalServiceId,
          });
        }

        if (media.externalServiceId4k && is4k) {
          radarr = await radarrAPI.getMovie({
            id: media.externalServiceId4k,
          });
        }

        if (radarr && radarr.hasFile) {
          const resolution =
            radarr?.movieFile?.mediaInfo?.resolution?.split('x');
          const is4kMovie =
            resolution?.length === 2 && Number(resolution[0]) >= 2000;

          if (hasSameServerInBothModes && resolution?.length === 2) {
            // Same server in both modes then use resolution to distinguish
            existsInRadarr = is4k ? is4kMovie : !is4kMovie;
          } else {
            // One server type and if file exists, count it
            existsInRadarr = true;
          }
        }
      } catch (ex) {
        if (!ex.message.includes('404')) {
          existsInRadarr = true;
          logger.debug(
            `Failure retrieving the ${is4k ? '4K' : 'non-4K'} movie [TMDB ID ${
              media.tmdbId
            }] from Radarr.`,
            {
              errorMessage: ex.message,
              label: 'Availability Sync',
            }
          );
        }
      }

      if (existsInRadarr) break;
    }

    return existsInRadarr;
  }

  private async mediaExistsInSonarr(
    media: Media,
    is4k: boolean
  ): Promise<{ existsInSonarr: boolean; seasonsMap: Map<number, boolean> }> {
    let existsInSonarr = false;
    let preventSeasonSearch = false;

    // Check for availability in all of the available sonarr servers
    // If any find the media, we will assume the media exists
    for (const server of this.sonarrServers.filter((server) => {
      return server.is4k === is4k;
    })) {
      const sonarrAPI = new SonarrAPI({
        apiKey: server.apiKey,
        url: SonarrAPI.buildUrl(server, '/api/v3'),
      });

      try {
        let sonarr: SonarrSeries | undefined;

        if (media.externalServiceId && !is4k) {
          sonarr = await sonarrAPI.getSeriesById(media.externalServiceId);
          this.sonarrSeasonsCache[`${server.id}-${media.externalServiceId}`] =
            sonarr.seasons;
        }

        if (media.externalServiceId4k && is4k) {
          sonarr = await sonarrAPI.getSeriesById(media.externalServiceId4k);
          this.sonarrSeasonsCache[`${server.id}-${media.externalServiceId4k}`] =
            sonarr.seasons;
        }

        if (sonarr && sonarr.statistics.episodeFileCount > 0) {
          existsInSonarr = true;
        }
      } catch (ex) {
        if (!ex.message.includes('404')) {
          existsInSonarr = true;
          preventSeasonSearch = true;
          logger.debug(
            `Failure retrieving the ${is4k ? '4K' : 'non-4K'} show [TMDB ID ${
              media.tmdbId
            }] from Sonarr.`,
            {
              errorMessage: ex.message,
              label: 'Availability Sync',
            }
          );
        }
      }
    }

    // Here we check each season for availability
    // If the API returns an error other than a 404,
    // we will have to prevent the season check from happening
    const seasonsMap: Map<number, boolean> = new Map();

    if (!preventSeasonSearch) {
      const filteredSeasons = media.seasons.filter(
        (season) =>
          season[is4k ? 'status4k' : 'status'] === MediaStatus.AVAILABLE ||
          season[is4k ? 'status4k' : 'status'] ===
            MediaStatus.PARTIALLY_AVAILABLE
      );

      for (const season of filteredSeasons) {
        const seasonExists = await this.seasonExistsInSonarr(
          media,
          season,
          is4k
        );

        if (seasonExists) {
          seasonsMap.set(season.seasonNumber, true);
        }
      }
    }

    return { existsInSonarr, seasonsMap };
  }

  private async seasonExistsInSonarr(
    media: Media,
    season: Season,
    is4k: boolean
  ): Promise<boolean> {
    let seasonExists = false;

    // Check each sonarr instance to see if the media still exists
    // If found, we will assume the media exists and prevent removal
    // We can use the cache we built when we fetched the series with mediaExistsInSonarr
    for (const server of this.sonarrServers.filter(
      (server) => server.is4k === is4k
    )) {
      let sonarrSeasons: SonarrSeason[] | undefined;

      if (media.externalServiceId && !is4k) {
        sonarrSeasons =
          this.sonarrSeasonsCache[`${server.id}-${media.externalServiceId}`];
      }

      if (media.externalServiceId4k && is4k) {
        sonarrSeasons =
          this.sonarrSeasonsCache[`${server.id}-${media.externalServiceId4k}`];
      }

      const seasonIsAvailable = sonarrSeasons?.find(
        ({ seasonNumber, statistics }) =>
          season.seasonNumber === seasonNumber &&
          statistics?.episodeFileCount &&
          statistics?.episodeFileCount > 0
      );

      if (seasonIsAvailable && sonarrSeasons) {
        seasonExists = true;
      }
    }

    return seasonExists;
  }

  // Plex
  private async mediaExistsInPlex(
    media: Media,
    is4k: boolean
  ): Promise<{ existsInPlex: boolean; seasonsMap?: Map<number, boolean> }> {
    if (!this.plexClient) return { existsInPlex: false };
    const plexClient = this.plexClient;
    const ratingKey = media.ratingKey;
    const ratingKey4k = media.ratingKey4k;
    let existsInPlex = false;
    let preventSeasonSearch = false;

    // Check each plex instance to see if the media still exists
    // If found, we will assume the media exists and prevent removal
    // We can use the cache we built when we fetched the series with mediaExistsInPlex
    try {
      let plexMedia: PlexMetadata | undefined;

      if (ratingKey && !is4k) {
        plexMedia = await plexClient.getMetadata(ratingKey);

        if (media.mediaType === 'tv') {
          this.plexSeasonsCache[ratingKey] =
            await plexClient.getChildrenMetadata(ratingKey);
        }
      }

      if (ratingKey4k && is4k) {
        plexMedia = await plexClient.getMetadata(ratingKey4k);

        if (media.mediaType === 'tv') {
          this.plexSeasonsCache[ratingKey4k] =
            await plexClient.getChildrenMetadata(ratingKey4k);
        }

        if (plexMedia) {
          if (ratingKey === ratingKey4k) {
            plexMedia = undefined;
          }

          if (
            plexMedia &&
            media.mediaType === 'movie' &&
            !plexMedia.Media?.some(
              (mediaItem) => (mediaItem.width ?? 0) >= 2000
            )
          ) {
            plexMedia = undefined;
          }

          if (plexMedia && media.mediaType === 'tv') {
            const cachedSeasons = this.plexSeasonsCache[ratingKey4k];
            if (cachedSeasons?.length) {
              let has4kInAnySeason = false;
              for (const season of cachedSeasons) {
                try {
                  const episodes = await this.plexClient?.getChildrenMetadata(
                    season.ratingKey
                  );
                  const has4kEpisode = episodes?.some((episode) =>
                    episode.Media?.some(
                      (mediaItem) => (mediaItem.width ?? 0) >= 2000
                    )
                  );
                  if (has4kEpisode) {
                    has4kInAnySeason = true;
                    break;
                  }
                } catch {
                  // If we can't fetch episodes for a season, continue checking other seasons
                }
              }
              if (!has4kInAnySeason) {
                plexMedia = undefined;
              }
            }
          }
        }
      }

      if (plexMedia) {
        existsInPlex = true;
      }
    } catch (ex) {
      if (!ex.message.includes('404')) {
        existsInPlex = true;
        preventSeasonSearch = true;
        logger.debug(
          `Failure retrieving the ${is4k ? '4K' : 'non-4K'} ${
            media.mediaType === 'tv' ? 'show' : 'movie'
          } [TMDB ID ${media.tmdbId}] from Plex.`,
          {
            errorMessage: ex.message,
            label: 'Availability Sync',
          }
        );
      }
    }

    // Here we check each season in plex for availability
    // If the API returns an error other than a 404,
    // we will have to prevent the season check from happening
    if (media.mediaType === 'tv') {
      const seasonsMap: Map<number, boolean> = new Map();

      if (!preventSeasonSearch) {
        const filteredSeasons = media.seasons.filter(
          (season) =>
            season[is4k ? 'status4k' : 'status'] === MediaStatus.AVAILABLE ||
            season[is4k ? 'status4k' : 'status'] ===
              MediaStatus.PARTIALLY_AVAILABLE
        );

        for (const season of filteredSeasons) {
          const seasonExists = await this.seasonExistsInPlex(
            media,
            season,
            is4k
          );

          if (seasonExists) {
            seasonsMap.set(season.seasonNumber, true);
          }
        }
      }

      return { existsInPlex, seasonsMap };
    }

    return { existsInPlex };
  }

  private async seasonExistsInPlex(
    media: Media,
    season: Season,
    is4k: boolean
  ): Promise<boolean> {
    const ratingKey = media.ratingKey;
    const ratingKey4k = media.ratingKey4k;
    let seasonExistsInPlex = false;

    // Check each plex instance to see if the season exists
    let plexSeasons: PlexMetadata[] | undefined;

    if (ratingKey && !is4k) {
      plexSeasons = this.plexSeasonsCache[ratingKey];
    }

    if (ratingKey4k && is4k) {
      plexSeasons = this.plexSeasonsCache[ratingKey4k];
    }

    const seasonIsAvailable = plexSeasons?.find(
      (plexSeason) => plexSeason.index === season.seasonNumber
    );

    if (seasonIsAvailable) {
      seasonExistsInPlex = true;
    }

    return seasonExistsInPlex;
  }

  // Jellyfin
  private async mediaExistsInJellyfin(
    media: Media,
    is4k: boolean
  ): Promise<{ existsInJellyfin: boolean; seasonsMap?: Map<number, boolean> }> {
    if (!this.jellyfinClient) return { existsInJellyfin: false };
    const jellyfinClient = this.jellyfinClient;
    const ratingKey = media.jellyfinMediaId;
    const ratingKey4k = media.jellyfinMediaId4k;
    let existsInJellyfin = false;
    let preventSeasonSearch = false;

    // Check each jellyfin instance to see if the media still exists
    // If found, we will assume the media exists and prevent removal
    // We can use the cache we built when we fetched the series with mediaExistsInJellyfin
    try {
      let jellyfinMedia: JellyfinLibraryItem | undefined;

      if (ratingKey && !is4k) {
        jellyfinMedia = await jellyfinClient.getItemData(ratingKey);

        if (media.mediaType === 'tv' && jellyfinMedia !== undefined) {
          this.jellyfinSeasonsCache[ratingKey] =
            await jellyfinClient.getSeasons(ratingKey);
        }
      }

      if (ratingKey4k && is4k) {
        jellyfinMedia = await jellyfinClient.getItemData(ratingKey4k);

        if (media.mediaType === 'tv' && jellyfinMedia !== undefined) {
          this.jellyfinSeasonsCache[ratingKey4k] =
            await jellyfinClient.getSeasons(ratingKey4k);
        }
      }

      if (jellyfinMedia) {
        existsInJellyfin = true;
      }
    } catch (ex) {
      if (!ex.message.includes('404') && !ex.message.includes('500')) {
        existsInJellyfin = true;
        preventSeasonSearch = true;
        logger.debug(
          `Failure retrieving the ${is4k ? '4K' : 'non-4K'} ${
            media.mediaType === 'tv' ? 'show' : 'movie'
          } [TMDB ID ${media.tmdbId}] from Jellyfin.`,
          {
            errorMessage: ex.message,
            label: 'AvailabilitySync',
          }
        );
      }
    }

    // Here we check each season in jellyfin for availability
    // If the API returns an error other than a 404,
    // we will have to prevent the season check from happening
    if (media.mediaType === 'tv') {
      const seasonsMap: Map<number, boolean> = new Map();

      if (!preventSeasonSearch) {
        const filteredSeasons = media.seasons.filter(
          (season) =>
            season[is4k ? 'status4k' : 'status'] === MediaStatus.AVAILABLE ||
            season[is4k ? 'status4k' : 'status'] ===
              MediaStatus.PARTIALLY_AVAILABLE
        );

        for (const season of filteredSeasons) {
          const seasonExists = await this.seasonExistsInJellyfin(
            media,
            season,
            is4k
          );

          if (seasonExists) {
            seasonsMap.set(season.seasonNumber, true);
          }
        }
      }

      return { existsInJellyfin, seasonsMap };
    }

    return { existsInJellyfin };
  }

  private async seasonExistsInJellyfin(
    media: Media,
    season: Season,
    is4k: boolean
  ): Promise<boolean> {
    const ratingKey = media.jellyfinMediaId;
    const ratingKey4k = media.jellyfinMediaId4k;
    let seasonExistsInJellyfin = false;

    // Check each jellyfin instance to see if the season exists
    let jellyfinSeasons: JellyfinLibraryItem[] | undefined;

    if (ratingKey && !is4k) {
      jellyfinSeasons = this.jellyfinSeasonsCache[ratingKey];
    }

    if (ratingKey4k && is4k) {
      jellyfinSeasons = this.jellyfinSeasonsCache[ratingKey4k];
    }

    const seasonIsAvailable = jellyfinSeasons?.find(
      (jellyfinSeason) => jellyfinSeason.IndexNumber === season.seasonNumber
    );

    if (seasonIsAvailable) {
      seasonExistsInJellyfin = true;
    }

    return seasonExistsInJellyfin;
  }

  // Emby
  private async mediaExistsInEmby(
    media: Media,
    is4k: boolean
  ): Promise<{ existsInEmby: boolean; seasonsMap?: Map<number, boolean> }> {
    if (!this.embyClient) return { existsInEmby: false };
    const embyClient = this.embyClient;
    const ratingKey = media.embyMediaId;
    const ratingKey4k = media.embyMediaId4k;
    let existsInEmby = false;
    let preventSeasonSearch = false;

    try {
      let embyMedia: JellyfinLibraryItem | undefined;

      if (ratingKey && !is4k) {
        embyMedia = await embyClient.getItemData(ratingKey);

        if (media.mediaType === 'tv' && embyMedia !== undefined) {
          this.embySeasonsCache[ratingKey] =
            await embyClient.getSeasons(ratingKey);
        }
      }

      if (ratingKey4k && is4k) {
        embyMedia = await embyClient.getItemData(ratingKey4k);

        if (media.mediaType === 'tv' && embyMedia !== undefined) {
          this.embySeasonsCache[ratingKey4k] =
            await embyClient.getSeasons(ratingKey4k);
        }
      }

      if (embyMedia) {
        existsInEmby = true;
      }
    } catch (ex) {
      if (!ex.message.includes('404') && !ex.message.includes('500')) {
        existsInEmby = true;
        preventSeasonSearch = true;
        logger.debug(
          `Failure retrieving the ${is4k ? '4K' : 'non-4K'} ${
            media.mediaType === 'tv' ? 'show' : 'movie'
          } [TMDB ID ${media.tmdbId}] from Emby.`,
          {
            errorMessage: ex.message,
            label: 'AvailabilitySync',
          }
        );
      }
    }

    if (media.mediaType === 'tv') {
      const seasonsMap: Map<number, boolean> = new Map();

      if (!preventSeasonSearch) {
        const filteredSeasons = media.seasons.filter(
          (season) =>
            season[is4k ? 'status4k' : 'status'] === MediaStatus.AVAILABLE ||
            season[is4k ? 'status4k' : 'status'] ===
              MediaStatus.PARTIALLY_AVAILABLE
        );

        for (const season of filteredSeasons) {
          const seasonExists = await this.seasonExistsInEmby(
            media,
            season,
            is4k
          );

          if (seasonExists) {
            seasonsMap.set(season.seasonNumber, true);
          }
        }
      }

      return { existsInEmby, seasonsMap };
    }

    return { existsInEmby };
  }

  private async seasonExistsInEmby(
    media: Media,
    season: Season,
    is4k: boolean
  ): Promise<boolean> {
    const ratingKey = media.embyMediaId;
    const ratingKey4k = media.embyMediaId4k;
    let embySeasons: JellyfinLibraryItem[] | undefined;

    if (ratingKey && !is4k) {
      embySeasons = this.embySeasonsCache[ratingKey];
    }

    if (ratingKey4k && is4k) {
      embySeasons = this.embySeasonsCache[ratingKey4k];
    }

    return !!embySeasons?.find(
      (embySeason) => embySeason.IndexNumber === season.seasonNumber
    );
  }
}

const availabilitySync = new AvailabilitySync();

export default availabilitySync;
