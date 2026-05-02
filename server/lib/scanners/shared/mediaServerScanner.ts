/**
 * Shared scanner skeleton for Jellyfin and Emby.
 * Both scanners share the same MediaBrowser API surface; they differ only in
 * the settings block they read, the gate flag they check, and the Media
 * columns they write to.
 */
import animeList from '@server/api/animelist';
import type JellyfinAPI from '@server/api/jellyfin';
import type {
  JellyfinLibraryItem,
  JellyfinLibraryItemExtended,
} from '@server/api/jellyfin';
import { getMetadataProvider } from '@server/api/metadata';
import TheMovieDb from '@server/api/themoviedb';
import { ANIME_KEYWORD_ID } from '@server/api/themoviedb/constants';
import type {
  TmdbKeyword,
  TmdbTvDetails,
} from '@server/api/themoviedb/interfaces';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import type {
  ProcessableSeason,
  RunnableScanner,
  StatusBase,
} from '@server/lib/scanners/baseScanner';
import BaseScanner from '@server/lib/scanners/baseScanner';
import type {
  EmbySettings,
  JellyfinSettings,
  Library,
} from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { uniqWith } from 'lodash';

export interface MediaServerSyncStatus extends StatusBase {
  currentLibrary: Library;
  libraries: Library[];
  duplicatesSkipped: number;
  lastRunAt: number;
  lastRunDuplicatesSkipped: number;
  lastRunCompleted: boolean;
}

export interface MediaServerScannerOptions {
  /** Return the JellyfinSettings or EmbySettings block from current settings. */
  settingsSelector: () => JellyfinSettings | EmbySettings;
  /** Boolean flag on settings.main that gates this scanner. */
  gateFlag: 'jellyfinLoginEnabled' | 'embyLoginEnabled';
  /** The MediaServerType enum value for the legacy mediaServerType gate. */
  mediaServerType: MediaServerType.JELLYFIN | MediaServerType.EMBY;
  /**
   * Canonical provider identifier. Used for log labels and any place that
   * would otherwise reconstruct the provider name from `mediaServerType`.
   * Optional for backwards compatibility — falls back to deriving from
   * `mediaServerType` when omitted.
   */
  provider?: 'jellyfin' | 'emby';
  /** Build the API client from the resolved settings block. */
  apiFactory: (
    settings: JellyfinSettings | EmbySettings,
    userToken: string | null,
    deviceId: string | null
  ) => JellyfinAPI;
  /** Field name for the standard media ID column. */
  mediaIdField: 'jellyfinMediaId' | 'embyMediaId';
  /** Field name for the 4K media ID column. */
  mediaIdField4k: 'jellyfinMediaId4k' | 'embyMediaId4k';
  /** Human-readable label used in log messages. */
  scannerLabel: string;
}

export class MediaServerScanner
  extends BaseScanner<JellyfinLibraryItem>
  implements RunnableScanner<MediaServerSyncStatus>
{
  private client: JellyfinAPI;
  private libraries: Library[];
  private currentLibrary: Library;
  private isRecentOnly = false;
  private processedAnidbSeason: Map<number, Map<number, number>>;
  private readonly opts: MediaServerScannerOptions;

  constructor(
    opts: MediaServerScannerOptions,
    { isRecentOnly }: { isRecentOnly?: boolean } = {}
  ) {
    super(`${opts.scannerLabel} Sync`);
    this.opts = opts;
    this.isRecentOnly = isRecentOnly ?? false;
  }

  private async extractMovieIds(item: JellyfinLibraryItem): Promise<{
    tmdbId: number;
    imdbId?: string;
    metadata: JellyfinLibraryItemExtended;
  } | null> {
    let metadata = await this.client.getItemData(item.Id);

    if (!metadata?.Id) {
      this.log('No Id metadata for this title. Skipping', 'debug', {
        itemId: item.Id,
      });
      return null;
    }

    const anidbId = Number(metadata.ProviderIds.AniDB ?? null);
    let tmdbId = Number(
      metadata.ProviderIds.Tmdb || metadata.ProviderIds.TheMovieDb || null
    );
    let imdbId = metadata.ProviderIds.Imdb;

    if (anidbId && !imdbId && !tmdbId) {
      const result = animeList.getFromAnidbId(anidbId);
      tmdbId = Number(result?.tmdbId ?? null);
      imdbId = result?.imdbId;
    }

    if (imdbId && !tmdbId) {
      const tmdbMovie = await this.tmdb.getMediaByImdbId({ imdbId });
      tmdbId = tmdbMovie.id;
    }

    if (!tmdbId) {
      throw new Error('Unable to find TMDb ID');
    }

    // With AniDB we can have mixed libraries with movies in a "show" library.
    if (anidbId && metadata.Type === 'Series') {
      const season = (await this.client.getSeasons(item.Id)).find(
        (md) => md.IndexNumber === 1
      );
      if (!season) {
        this.log('No season found for anidb movie', 'debug', { item });
        return null;
      }
      const episodes = await this.client.getEpisodes(item.Id, season.Id);
      if (!episodes[0]) {
        this.log('No episode found for anidb movie', 'debug', { item });
        return null;
      }
      metadata = await this.client.getItemData(episodes[0].Id);
      if (!metadata) {
        this.log('No metadata found for anidb movie', 'debug', { item });
        return null;
      }
    }

    return { tmdbId, imdbId, metadata };
  }

  private async processMediaMovie(item: JellyfinLibraryItem): Promise<void> {
    try {
      const extracted = await this.extractMovieIds(item);
      if (!extracted) return;

      const { tmdbId, imdbId, metadata } = extracted;

      const has4k = metadata.MediaSources?.some((source) =>
        source.MediaStreams.filter((s) => s.Type === 'Video').some(
          (s) => (s.Width ?? 0) > 2000
        )
      );

      const hasOtherResolution = metadata.MediaSources?.some((source) =>
        source.MediaStreams.filter((s) => s.Type === 'Video').some(
          (s) => (s.Width ?? 0) <= 2000
        )
      );

      const mediaAddedAt = metadata.DateCreated
        ? new Date(metadata.DateCreated)
        : undefined;

      const mediaIdOptions = {
        [this.opts.mediaIdField]: metadata.Id,
      } as Record<string, string>;

      if (hasOtherResolution || (!this.enable4kMovie && has4k)) {
        await this.processMovie(tmdbId, {
          is4k: false,
          mediaAddedAt,
          ...mediaIdOptions,
          imdbId,
          title: metadata.Name,
        });
      }

      if (has4k && this.enable4kMovie) {
        await this.processMovie(tmdbId, {
          is4k: true,
          mediaAddedAt,
          ...mediaIdOptions,
          imdbId,
          title: metadata.Name,
        });
      }
    } catch (e) {
      this.log(
        `Failed to process ${this.opts.scannerLabel} item, id: ${item.Id}`,
        'error',
        { errorMessage: (e as Error).message, item }
      );
    }
  }

  private async getTvShow({
    tmdbId,
    tvdbId,
  }: {
    tmdbId?: number;
    tvdbId?: number;
  }): Promise<TmdbTvDetails> {
    let tvShow: TmdbTvDetails;

    if (tmdbId) {
      tvShow = await this.tmdb.getTvShow({ tvId: Number(tmdbId) });
    } else if (tvdbId) {
      tvShow = await this.tmdb.getShowByTvdbId({ tvdbId: Number(tvdbId) });
    } else {
      throw new Error('No ID provided');
    }

    const metadataProvider = tvShow.keywords.results.some(
      (keyword: TmdbKeyword) => keyword.id === ANIME_KEYWORD_ID
    )
      ? await getMetadataProvider('anime')
      : await getMetadataProvider('tv');

    if (!(metadataProvider instanceof TheMovieDb)) {
      tvShow = await metadataProvider.getTvShow({ tvId: Number(tmdbId) });
    }

    return tvShow;
  }

  private async processMediaShow(item: JellyfinLibraryItem): Promise<void> {
    let tvShow: TmdbTvDetails | null = null;

    try {
      const Id = item.SeriesId ?? item.SeasonId ?? item.Id;
      const metadata = await this.client.getItemData(Id);

      if (!metadata?.Id) {
        this.log('No Id metadata for this title. Skipping', 'debug', {
          itemId: item.Id,
        });
        return;
      }

      if (metadata.ProviderIds.Tmdb || metadata.ProviderIds.TheMovieDb) {
        try {
          tvShow = await this.getTvShow({
            tmdbId: Number(
              metadata.ProviderIds.Tmdb || metadata.ProviderIds.TheMovieDb
            ),
          });
        } catch {
          this.log('Unable to find TMDb ID for this title.', 'debug', { item });
        }
      }

      if (!tvShow && metadata.ProviderIds.Tvdb) {
        try {
          tvShow = await this.getTvShow({
            tvdbId: Number(metadata.ProviderIds.Tvdb),
          });
        } catch {
          this.log('Unable to find TVDb ID for this title.', 'debug', { item });
        }
      }

      let tvdbSeasonFromAnidb: number | undefined;
      if (!tvShow && metadata.ProviderIds.AniDB) {
        const anidbId = Number(metadata.ProviderIds.AniDB);
        const result = animeList.getFromAnidbId(anidbId);
        tvdbSeasonFromAnidb = result?.tvdbSeason;
        if (result?.tvdbId) {
          try {
            tvShow = await this.tmdb.getShowByTvdbId({ tvdbId: result.tvdbId });
          } catch {
            this.log('Unable to find AniDB ID for this title.', 'debug', {
              item,
            });
          }
        } else if (result?.imdbId || result?.tmdbId) {
          await this.processMediaMovie(item);
          return;
        }
      }

      if (tvShow) {
        const seasons = tvShow.seasons;
        const serverSeasons = await this.client.getSeasons(Id);

        const processableSeasons: ProcessableSeason[] = [];

        const settings = getSettings();
        const filteredSeasons = settings.main.enableSpecialEpisodes
          ? seasons
          : seasons.filter((sn) => sn.season_number !== 0);

        for (const season of filteredSeasons) {
          const matchedSeason = serverSeasons.find((md) => {
            if (tvdbSeasonFromAnidb) {
              return (
                tvdbSeasonFromAnidb === season.season_number &&
                md.IndexNumber === 1
              );
            } else {
              return Number(md.IndexNumber) === season.season_number;
            }
          });

          if (matchedSeason) {
            let totalStandard = 0;
            let total4k = 0;

            if (!this.enable4kShow) {
              const episodes = await this.client.getEpisodes(
                Id,
                matchedSeason.Id
              );

              for (const episode of episodes) {
                let episodeCount = 1;
                if (
                  episode.IndexNumber !== undefined &&
                  episode.IndexNumberEnd !== undefined
                ) {
                  episodeCount =
                    episode.IndexNumberEnd - episode.IndexNumber + 1;
                }
                totalStandard += episodeCount;
              }
            } else {
              const episodes = await this.client.getEpisodes(
                Id,
                matchedSeason.Id,
                { includeMediaInfo: true }
              );

              for (const episode of episodes) {
                let episodeCount = 1;
                if (
                  episode.IndexNumber !== undefined &&
                  episode.IndexNumberEnd !== undefined
                ) {
                  episodeCount =
                    episode.IndexNumberEnd - episode.IndexNumber + 1;
                }

                const has4k = episode.MediaSources?.some((source) =>
                  source.MediaStreams.some(
                    (s) => s.Type === 'Video' && (s.Width ?? 0) > 2000
                  )
                );

                const hasStandard = episode.MediaSources?.some((source) =>
                  source.MediaStreams.some(
                    (s) => s.Type === 'Video' && (s.Width ?? 0) <= 2000
                  )
                );

                if (hasStandard) totalStandard += episodeCount;
                if (has4k) total4k += episodeCount;
              }
            }

            if (tvdbSeasonFromAnidb) {
              let show = this.processedAnidbSeason.get(tvShow.id);
              if (!show) {
                show = new Map([[season.season_number, totalStandard]]);
                this.processedAnidbSeason.set(tvShow.id, show);
              } else {
                const currentCount = show.get(season.season_number) ?? 0;
                const newCount = currentCount + totalStandard;
                show.set(season.season_number, newCount);
                totalStandard = newCount;
              }
            }

            processableSeasons.push({
              seasonNumber: season.season_number,
              totalEpisodes: season.episode_count,
              episodes: totalStandard,
              episodes4k: total4k,
            });
          } else {
            processableSeasons.push({
              seasonNumber: season.season_number,
              totalEpisodes: season.episode_count,
              episodes: 0,
              episodes4k: 0,
            });
          }
        }

        const mediaIdOptions = {
          [this.opts.mediaIdField]: Id,
        } as Record<string, string>;

        await this.processShow(
          tvShow.id,
          tvShow.external_ids?.tvdb_id,
          processableSeasons,
          {
            mediaAddedAt: metadata.DateCreated
              ? new Date(metadata.DateCreated)
              : undefined,
            ...mediaIdOptions,
            title: tvShow.name,
          }
        );
      } else {
        this.log(
          `No information found for the show: ${metadata.Name}`,
          'debug',
          { item }
        );
      }
    } catch (e) {
      this.log(
        `Failed to process ${this.opts.scannerLabel} item. Id: ${
          item.SeriesId ?? item.SeasonId ?? item.Id
        }`,
        'error',
        { errorMessage: (e as Error).message, item }
      );
    }
  }

  private async processItem(item: JellyfinLibraryItem): Promise<void> {
    // Dedup gate BEFORE any TMDb resolution / network work. Keys roll up to
    // series/season level when present so episode fan-out within the same
    // series counts once.
    const dedupKey = String(item.SeriesId ?? item.SeasonId ?? item.Id);
    if (this.markDuplicate(dedupKey)) {
      return;
    }

    if (item.Type === 'Movie') {
      await this.processMediaMovie(item);
    } else if (item.Type === 'Series') {
      await this.processMediaShow(item);
    }
  }

  public async run(): Promise<void> {
    const settings = getSettings();
    const gateEnabled = settings.main[this.opts.gateFlag];

    // Phase 8 split makes the *LoginEnabled flags the source of truth.
    // The 0010 settings migration sets these flags from the legacy
    // mediaServerType, so we no longer need a legacy fallback here.
    if (!gateEnabled) {
      return;
    }

    const sessionId = this.startRun();
    let completed = false;

    try {
      const userRepository = getRepository(User);
      const admin = await userRepository.findOne({
        where: { id: 1 },
        select: [
          'id',
          'jellyfinUserId',
          'jellyfinDeviceId',
          'embyUserId',
          'embyDeviceId',
        ],
        order: { id: 'ASC' },
      });

      if (!admin) {
        return this.log(
          `No admin configured. ${this.opts.scannerLabel} sync skipped.`,
          'warn'
        );
      }

      const serverSettings = this.opts.settingsSelector();
      const provider =
        this.opts.provider ??
        (this.opts.mediaServerType === MediaServerType.EMBY
          ? 'emby'
          : 'jellyfin');
      const userId =
        provider === 'emby' ? admin.embyUserId : admin.jellyfinUserId;
      const deviceId =
        provider === 'emby' ? admin.embyDeviceId : admin.jellyfinDeviceId;

      this.client = this.opts.apiFactory(
        serverSettings,
        serverSettings.apiKey,
        deviceId ?? null
      );
      this.client.setUserId(userId ?? '');

      this.libraries = serverSettings.libraries.filter(
        (library) => library.enabled
      );

      await animeList.sync();

      if (this.isRecentOnly) {
        for (const library of this.libraries) {
          this.currentLibrary = library;
          this.processedAnidbSeason = new Map();
          this.log(
            `Beginning to process recently added for library: ${library.name}`,
            'info'
          );
          const libraryItems = await this.client.getRecentlyAdded(library.id);

          this.items = uniqWith(libraryItems, (mediaA, mediaB) => {
            if (mediaA.SeriesId && mediaB.SeriesId) {
              return mediaA.SeriesId === mediaB.SeriesId;
            }
            if (mediaA.SeasonId && mediaB.SeasonId) {
              return mediaA.SeasonId === mediaB.SeasonId;
            }
            return mediaA.Id === mediaB.Id;
          });

          await this.loop(this.processItem.bind(this), { sessionId });
        }
      } else {
        for (const library of this.libraries) {
          this.currentLibrary = library;
          this.processedAnidbSeason = new Map();
          this.log(`Beginning to process library: ${library.name}`, 'info');
          this.items = await this.client.getLibraryContents(library.id);
          await this.loop(this.processItem.bind(this), { sessionId });
        }
      }

      this.log(
        this.isRecentOnly
          ? 'Recently Added Scan Complete'
          : 'Full Scan Complete',
        'info',
        {
          duplicatesSkipped: this.duplicatesSkipped,
          totalProcessed: this.items?.length ?? 0,
        }
      );
      completed = true;
    } catch (e) {
      this.log('Sync interrupted', 'error', {
        errorMessage: (e as Error).message,
      });
    } finally {
      this.endRun(sessionId, completed);
    }
  }

  public status(): MediaServerSyncStatus {
    return {
      running: this.running,
      progress: this.progress,
      total: this.items.length,
      currentLibrary: this.currentLibrary,
      libraries: this.libraries,
      duplicatesSkipped: this.duplicatesSkipped,
      lastRunAt: this.lastRunAt,
      lastRunDuplicatesSkipped: this.lastRunDuplicatesSkipped,
      lastRunCompleted: this.lastRunCompleted,
    };
  }
}
