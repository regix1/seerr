import { getMetadataProvider } from '@server/api/metadata';
import type { SonarrSeries } from '@server/api/servarr/sonarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import { ANIME_KEYWORD_ID } from '@server/api/themoviedb/constants';
import type {
  TmdbKeyword,
  TmdbTvDetails,
} from '@server/api/themoviedb/interfaces';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import fileFlowsTracker from '@server/lib/fileflows';
import type {
  ProcessableSeason,
  RunnableScanner,
  StatusBase,
} from '@server/lib/scanners/baseScanner';
import BaseScanner from '@server/lib/scanners/baseScanner';
import type { SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { uniqWith } from 'lodash';

type SyncStatus = StatusBase & {
  currentServer: SonarrSettings;
  servers: SonarrSettings[];
};

class SonarrScanner
  extends BaseScanner<SonarrSeries>
  implements RunnableScanner<SyncStatus>
{
  private servers: SonarrSettings[];
  private currentServer: SonarrSettings;
  private sonarrApi: SonarrAPI;
  private scannedTvdbIds: Set<number> = new Set();
  private scanned4kTvdbIds: Set<number> = new Set();
  private didScanStandard = false;
  private didScan4k = false;

  constructor() {
    super('Sonarr Scan', { bundleSize: 50 });
  }

  public status(): SyncStatus {
    return {
      running: this.running,
      progress: this.progress,
      total: this.items.length,
      currentServer: this.currentServer,
      servers: this.servers,
    };
  }

  public async run(): Promise<void> {
    if (this.running) {
      this.log(
        'A Sonarr scan or availability check is already running. Skipping.',
        'info'
      );
      return;
    }

    const settings = getSettings();
    const sessionId = this.startRun();
    this.scannedTvdbIds.clear();
    this.scanned4kTvdbIds.clear();
    this.didScanStandard = false;
    this.didScan4k = false;

    try {
      this.servers = uniqWith(settings.sonarr, (sonarrA, sonarrB) => {
        return (
          sonarrA.hostname === sonarrB.hostname &&
          sonarrA.port === sonarrB.port &&
          sonarrA.baseUrl === sonarrB.baseUrl
        );
      });

      for (const server of this.servers) {
        this.currentServer = server;
        if (server.syncEnabled) {
          this.log(
            `Beginning to process Sonarr server: ${server.name}`,
            'info'
          );

          this.sonarrApi = new SonarrAPI({
            apiKey: server.apiKey,
            url: SonarrAPI.buildUrl(server, '/api/v3'),
          });

          this.items = await this.sonarrApi.getSeries();

          const server4k = this.enable4kShow && server.is4k;
          if (server4k) {
            this.didScan4k = true;
          } else {
            this.didScanStandard = true;
          }

          await this.loop(this.processSonarrSeries.bind(this), { sessionId });
        } else {
          this.log(`Sync not enabled. Skipping Sonarr server: ${server.name}`);
        }
      }

      // Only run cleanup if all servers of this profile type have sync enabled.
      // If any server is skipped, we can't distinguish truly orphaned media from
      // media that exists on an unscanned server (e.g. separate instances for
      // anime, regional content, or different languages).
      const allStandardScanned = this.servers
        .filter((s) => !this.enable4kShow || !s.is4k)
        .every((s) => s.syncEnabled);
      const all4kScanned = this.servers
        .filter((s) => this.enable4kShow && s.is4k)
        .every((s) => s.syncEnabled);

      if (!allStandardScanned) {
        this.didScanStandard = false;
      }
      if (!all4kScanned) {
        this.didScan4k = false;
      }

      await this.cleanupOrphanedShows();
      this.log('Sonarr scan complete', 'info');
    } catch (e) {
      this.log('Scan interrupted', 'error', { errorMessage: e.message });
    } finally {
      this.endRun(sessionId);
    }
  }

  private async processSonarrSeries(sonarrSeries: SonarrSeries) {
    const server4k = this.enable4kShow && this.currentServer.is4k;
    if (server4k) {
      this.scanned4kTvdbIds.add(sonarrSeries.tvdbId);
    } else {
      this.scannedTvdbIds.add(sonarrSeries.tvdbId);
    }

    try {
      const mediaRepository = getRepository(Media);
      const processableSeasons: ProcessableSeason[] = [];
      let tvShow: TmdbTvDetails;

      const media = await mediaRepository.findOne({
        where: { tvdbId: sonarrSeries.tvdbId },
      });

      if (!media || !media.tmdbId) {
        tvShow = await this.tmdb.getShowByTvdbId({
          tvdbId: sonarrSeries.tvdbId,
        });
      } else {
        tvShow = await this.tmdb.getTvShow({ tvId: media.tmdbId });
      }

      const tmdbId = tvShow.id;
      const metadataProvider = tvShow.keywords.results.some(
        (keyword: TmdbKeyword) => keyword.id === ANIME_KEYWORD_ID
      )
        ? await getMetadataProvider('anime')
        : await getMetadataProvider('tv');

      if (!(metadataProvider instanceof TheMovieDb)) {
        tvShow = await metadataProvider.getTvShow({ tvId: tmdbId });
      }

      const settings = getSettings();

      const filteredSeasons = tvShow.seasons
        .filter(
          (sn) => settings.main.enableSpecialEpisodes || sn.season_number !== 0
        )
        .map((season) => {
          const sonarrSeason = sonarrSeries.seasons.find(
            (s) => s.seasonNumber === season.season_number
          );
          if (!sonarrSeason) {
            return {
              seasonNumber: season.season_number,
              episodeCount: season.episode_count,
              monitored: false,
              statistics: {
                episodeFileCount: 0,
                totalEpisodeCount: season.episode_count,
              },
            };
          } else {
            return sonarrSeason;
          }
        });

      // FileFlows gate: if FileFlows is still post-processing episode files for
      // this series, keep the affected season(s) from flipping to available
      // (and the available notification from firing) until processing
      // completes. Episode files are matched by filename, per season. The
      // episode-file lookup only runs when FileFlows is actively processing
      // something — otherwise the tracker short-circuits to a no-op.
      const fileFlowsSeasons = new Set<number>();
      const sonarrSeriesId = sonarrSeries.id;
      if (
        sonarrSeriesId !== undefined &&
        (await fileFlowsTracker.hasProcessingFiles())
      ) {
        try {
          const episodeFiles =
            await this.sonarrApi.getEpisodeFiles(sonarrSeriesId);
          for (const file of episodeFiles) {
            if (
              await fileFlowsTracker.isFileProcessing(
                file.relativePath ?? file.path
              )
            ) {
              fileFlowsSeasons.add(file.seasonNumber);
            }
          }
        } catch {
          // If episode files can't be enumerated, fall back to not holding
          // (fail open) rather than blocking availability.
        }
        if (fileFlowsSeasons.size > 0) {
          fileFlowsTracker.markHeld(`tvdb:${sonarrSeries.tvdbId}`);
          this.log(
            `FileFlows is still processing season(s) ${[
              ...fileFlowsSeasons,
            ].join(', ')} of "${sonarrSeries.title}"; deferring availability`,
            'debug'
          );
        }
      }

      // A series held by FileFlows (resolved via the release parser, e.g. a
      // renamed or -xpost file the per-episode filename match misses) keeps its
      // not-yet-complete seasons in processing, so availability and the
      // available notification are deferred until FileFlows finishes. Once the
      // hold expires the next scan restores the real status.
      const tvHeld = fileFlowsTracker.isHeld(
        `tvdb:${sonarrSeries.tvdbId}`,
        `tmdb:${tmdbId}`
      );

      for (const season of filteredSeasons) {
        const totalAvailableEpisodes = season.statistics?.episodeFileCount ?? 0;
        const totalEpisodes = season.statistics?.totalEpisodeCount ?? 0;

        processableSeasons.push({
          seasonNumber: season.seasonNumber,
          episodes: !server4k ? totalAvailableEpisodes : 0,
          episodes4k: server4k ? totalAvailableEpisodes : 0,
          totalEpisodes,
          processing:
            (season.monitored && totalAvailableEpisodes === 0) ||
            fileFlowsSeasons.has(season.seasonNumber) ||
            // Only defer seasons that are actually monitored or partially
            // present — never flip an unmonitored, empty season to processing.
            (tvHeld &&
              totalAvailableEpisodes < totalEpisodes &&
              (season.monitored || totalAvailableEpisodes > 0)),
          is4kOverride: server4k,
        });
      }

      await this.processShow(tmdbId, sonarrSeries.tvdbId, processableSeasons, {
        serviceId: this.currentServer.id,
        externalServiceId: sonarrSeries.id,
        externalServiceSlug: sonarrSeries.titleSlug,
        title: sonarrSeries.title,
        is4k: server4k,
      });
    } catch (e) {
      this.log('Failed to process Sonarr media', 'error', {
        errorMessage: e.message,
        title: sonarrSeries.title,
      });
    }
  }

  /**
   * Targeted availability check for a single series that is still PROCESSING.
   *
   * Reuses the same per-item path as the full scan (processSonarrSeries ->
   * processShow), so it inherits TMDB season-mapping + special-episode
   * filtering, the FileFlows gate + held seasons, the per-tmdbId DB lock, and
   * the MediaSubscriber notification cascade. It does NOT run a full library
   * scan.
   *
   * Serialized against the full scan: if a full Sonarr scan is already running
   * (this.running) the call is a no-op, since that scan will pick the item up
   * anyway and we must not race the shared instance state (currentServer /
   * sonarrApi). For its own (short) duration it flips `running` so a scheduled
   * full scan that checks `status().running` will not start mid-check.
   */
  public async checkPendingSeries(
    server: SonarrSettings,
    sonarrId: number,
    is4k: boolean
  ): Promise<void> {
    if (this.running) {
      this.log(
        `Skipping availability check for Sonarr id ${sonarrId}: a full Sonarr scan is already running`,
        'debug'
      );
      return;
    }

    this.running = true;
    try {
      const settings = getSettings();
      this.enable4kShow = settings.sonarr.some((sonarr) => sonarr.is4k);
      this.currentServer = server;
      this.sonarrApi = new SonarrAPI({
        apiKey: server.apiKey,
        url: SonarrAPI.buildUrl(server, '/api/v3'),
      });

      const sonarrSeries = await this.sonarrApi.getSeriesById(sonarrId);

      // Upgrade-only: a targeted availability check must never downgrade a
      // still-incomplete item. processSonarrSeries -> processShow can flip a
      // season (and the series rollup) PROCESSING -> UNKNOWN when a monitored
      // season reports zero episode files and is no longer processing. When no
      // season has any episode file there is nothing to upgrade, so skip and
      // leave the item in PROCESSING; the next check (or a full scan) will
      // pick it up.
      const hasAnyEpisodeFile = sonarrSeries.seasons.some(
        (season) => (season.statistics?.episodeFileCount ?? 0) > 0
      );

      if (!hasAnyEpisodeFile) {
        this.log(
          `Availability check: Sonarr id ${sonarrId} has no episode files yet; leaving as processing`,
          'debug'
        );
        return;
      }

      await this.processSonarrSeries(sonarrSeries);
    } catch (e) {
      const statusCode = (e as { cause?: { response?: { status?: number } } })
        .cause?.response?.status;
      const notFound =
        statusCode === 404 || /\b404\b/.test(String(e.message ?? ''));
      if (notFound) {
        // A stale externalServiceId (the series was removed from Sonarr, or a
        // link left over from a reset) returns 404. This is expected during a
        // targeted check, not an error: skip the item quietly and leave it as-is.
        logger.debug(
          `Sonarr id ${sonarrId} not found in Sonarr (stale link); skipping`,
          { label: 'Download Completion Check', sonarrId, is4k }
        );
      } else {
        this.log('Failed to check Sonarr media availability', 'error', {
          errorMessage: e.message,
          sonarrId,
          is4k,
        });
      }
    } finally {
      this.running = false;
    }
  }

  private async cleanupOrphanedShows(): Promise<void> {
    const mediaRepository = getRepository(Media);

    if (this.didScanStandard) {
      const processingShows = await mediaRepository.find({
        where: { mediaType: MediaType.TV, status: MediaStatus.PROCESSING },
        relations: ['seasons'],
      });

      for (const media of processingShows) {
        if (media.tvdbId && !this.scannedTvdbIds.has(media.tvdbId)) {
          media.status = MediaStatus.UNKNOWN;
          for (const season of media.seasons) {
            if (season.status === MediaStatus.PROCESSING) {
              season.status = MediaStatus.UNKNOWN;
            }
          }
          await mediaRepository.save(media);
          this.log(
            `Show ${media.tmdbId} (tvdb: ${media.tvdbId}) not found in any Sonarr server. Status reset to UNKNOWN.`,
            'info'
          );
        }
      }
    } else {
      this.log(
        'Skipping orphaned show cleanup: no standard Sonarr servers were scanned.',
        'info'
      );
    }

    if (this.didScan4k) {
      const processing4kShows = await mediaRepository.find({
        where: { mediaType: MediaType.TV, status4k: MediaStatus.PROCESSING },
        relations: ['seasons'],
      });

      for (const media of processing4kShows) {
        if (media.tvdbId && !this.scanned4kTvdbIds.has(media.tvdbId)) {
          media.status4k = MediaStatus.UNKNOWN;
          for (const season of media.seasons) {
            if (season.status4k === MediaStatus.PROCESSING) {
              season.status4k = MediaStatus.UNKNOWN;
            }
          }
          await mediaRepository.save(media);
          this.log(
            `Show ${media.tmdbId} (tvdb: ${media.tvdbId}) not found in any 4K Sonarr server. 4K status reset to UNKNOWN.`,
            'info'
          );
        }
      }
    } else if (this.enable4kShow) {
      this.log(
        'Skipping orphaned 4K show cleanup: no 4K Sonarr servers were scanned.',
        'info'
      );
    }
  }
}

export const sonarrScanner = new SonarrScanner();
