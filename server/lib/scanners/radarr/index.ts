import type { RadarrMovie } from '@server/api/servarr/radarr';
import RadarrAPI from '@server/api/servarr/radarr';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import fileFlowsTracker from '@server/lib/fileflows';
import type {
  RunnableScanner,
  StatusBase,
} from '@server/lib/scanners/baseScanner';
import BaseScanner from '@server/lib/scanners/baseScanner';
import type { RadarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { uniqWith } from 'lodash';

type SyncStatus = StatusBase & {
  currentServer: RadarrSettings;
  servers: RadarrSettings[];
};

class RadarrScanner
  extends BaseScanner<RadarrMovie>
  implements RunnableScanner<SyncStatus>
{
  private servers: RadarrSettings[];
  private currentServer: RadarrSettings;
  private radarrApi: RadarrAPI;
  private scannedTmdbIds: Set<number> = new Set();
  private scanned4kTmdbIds: Set<number> = new Set();
  private didScanStandard = false;
  private didScan4k = false;

  constructor() {
    super('Radarr Scan', { bundleSize: 50 });
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
        'A Radarr scan or availability check is already running. Skipping.',
        'info'
      );
      return;
    }

    const settings = getSettings();
    const sessionId = this.startRun();
    this.scannedTmdbIds.clear();
    this.scanned4kTmdbIds.clear();
    this.didScanStandard = false;
    this.didScan4k = false;

    try {
      this.servers = uniqWith(settings.radarr, (radarrA, radarrB) => {
        return (
          radarrA.hostname === radarrB.hostname &&
          radarrA.port === radarrB.port &&
          radarrA.baseUrl === radarrB.baseUrl
        );
      });

      for (const server of this.servers) {
        this.currentServer = server;
        if (server.syncEnabled) {
          this.log(
            `Beginning to process Radarr server: ${server.name}`,
            'info'
          );

          this.radarrApi = new RadarrAPI({
            apiKey: server.apiKey,
            url: RadarrAPI.buildUrl(server, '/api/v3'),
          });

          this.items = await this.radarrApi.getMovies();

          const server4k = this.enable4kMovie && server.is4k;
          if (server4k) {
            this.didScan4k = true;
          } else {
            this.didScanStandard = true;
          }

          await this.loop(this.processRadarrMovie.bind(this), { sessionId });
        } else {
          this.log(`Sync not enabled. Skipping Radarr server: ${server.name}`);
        }
      }

      // Only run cleanup if all servers of this profile type have sync enabled.
      // If any server is skipped, we can't distinguish truly orphaned media from
      // media that exists on an unscanned server (e.g. separate instances for
      // anime, regional content, or different languages).
      const allStandardScanned = this.servers
        .filter((s) => !this.enable4kMovie || !s.is4k)
        .every((s) => s.syncEnabled);
      const all4kScanned = this.servers
        .filter((s) => this.enable4kMovie && s.is4k)
        .every((s) => s.syncEnabled);

      if (!allStandardScanned) {
        this.didScanStandard = false;
      }
      if (!all4kScanned) {
        this.didScan4k = false;
      }

      await this.cleanupOrphanedMovies();
      this.log('Radarr scan complete', 'info');
    } catch (e) {
      this.log('Scan interrupted', 'error', { errorMessage: e.message });
    } finally {
      this.endRun(sessionId);
    }
  }

  private async processRadarrMovie(radarrMovie: RadarrMovie): Promise<void> {
    const server4k = this.enable4kMovie && this.currentServer.is4k;
    if (server4k) {
      this.scanned4kTmdbIds.add(radarrMovie.tmdbId);
    } else {
      this.scannedTmdbIds.add(radarrMovie.tmdbId);
    }

    try {
      let processing = !radarrMovie.hasFile && radarrMovie.monitored;

      // FileFlows gate: if the imported file is still being post-processed by
      // FileFlows, keep the movie marked as processing so it is not flipped to
      // available (and the available notification is not sent) prematurely.
      // Checks the persisted hold (set by the parser-based resolver, which
      // survives a rename/-xpost the filename match would miss), then the live
      // filename, then the release/folder name.
      const fileFlowsKey = `tmdb:${radarrMovie.tmdbId}`;
      // A *fresh* signal that FileFlows is actively working this file right now
      // (live processing-file name match, or release/folder match). The hold set
      // by the parser-based resolver is consulted separately, below.
      const freshlyProcessing =
        radarrMovie.hasFile &&
        ((await fileFlowsTracker.isFileProcessing(
          radarrMovie.movieFile?.relativePath ?? radarrMovie.movieFile?.path
        )) ||
          (await fileFlowsTracker.isReleaseProcessing(radarrMovie.title)));
      if (freshlyProcessing) {
        // Only (re)assert the hold on a fresh signal — never on isHeld alone, or
        // the hold would renew its own TTL on every scan and the movie would
        // never be released back to available once FileFlows finishes.
        fileFlowsTracker.markHeld(fileFlowsKey);
      }
      if (
        radarrMovie.hasFile &&
        (freshlyProcessing || fileFlowsTracker.isHeld(fileFlowsKey))
      ) {
        processing = true;
        this.log(
          `FileFlows is still processing "${radarrMovie.title}"; deferring availability`,
          'debug'
        );
      }

      await this.processMovie(radarrMovie.tmdbId, {
        is4k: server4k,
        serviceId: this.currentServer.id,
        externalServiceId: radarrMovie.id,
        externalServiceSlug: radarrMovie.titleSlug,
        title: radarrMovie.title,
        processing,
        hasFile: radarrMovie.hasFile,
      });
    } catch (e) {
      this.log('Failed to process Radarr media', 'error', {
        errorMessage: e.message,
        title: radarrMovie.title,
      });
    }
  }

  /**
   * Targeted availability check for a single movie that is still PROCESSING.
   *
   * Reuses the same per-item path as the full scan (processRadarrMovie ->
   * processMovie), so it inherits the FileFlows gate, the AVAILABLE/PROCESSING
   * status math, the per-tmdbId DB lock, and the MediaSubscriber notification
   * cascade. It does NOT run a full library scan.
   *
   * Serialized against the full scan: if a full Radarr scan is already running
   * (this.running) the call is a no-op, since that scan will pick the item up
   * anyway and we must not race the shared instance state (currentServer /
   * radarrApi). For its own (short) duration it flips `running` so a scheduled
   * full scan that checks `status().running` will not start mid-check.
   */
  public async checkPendingMovie(
    server: RadarrSettings,
    radarrId: number,
    is4k: boolean
  ): Promise<void> {
    if (this.running) {
      this.log(
        `Skipping availability check for Radarr id ${radarrId}: a full Radarr scan is already running`,
        'debug'
      );
      return;
    }

    this.running = true;
    try {
      const settings = getSettings();
      this.enable4kMovie = settings.radarr.some((radarr) => radarr.is4k);
      this.currentServer = server;
      this.radarrApi = new RadarrAPI({
        apiKey: server.apiKey,
        url: RadarrAPI.buildUrl(server, '/api/v3'),
      });

      const radarrMovie = await this.radarrApi.getMovie({ id: radarrId });

      // Upgrade-only: a targeted availability check must never downgrade a
      // still-incomplete item. processRadarrMovie -> processMovie can flip
      // PROCESSING -> UNKNOWN when the *arr item has no file and is not
      // processing (e.g. unmonitored/removed). When there is no file there is
      // nothing to upgrade, so skip and leave the item in PROCESSING; the next
      // check (or a full scan) will pick it up.
      if (!radarrMovie.hasFile) {
        this.log(
          `Availability check: Radarr id ${radarrId} has no file yet; leaving as processing`,
          'debug'
        );
        return;
      }

      await this.processRadarrMovie(radarrMovie);
    } catch (e) {
      this.log('Failed to check Radarr media availability', 'error', {
        errorMessage: e.message,
        radarrId,
        is4k,
      });
    } finally {
      this.running = false;
    }
  }

  private async cleanupOrphanedMovies(): Promise<void> {
    const mediaRepository = getRepository(Media);

    if (this.didScanStandard) {
      const processingMovies = await mediaRepository.find({
        where: { mediaType: MediaType.MOVIE, status: MediaStatus.PROCESSING },
      });

      for (const media of processingMovies) {
        if (!this.scannedTmdbIds.has(media.tmdbId)) {
          media.status = MediaStatus.UNKNOWN;
          await mediaRepository.save(media);
          this.log(
            `Movie ${media.tmdbId} not found in any Radarr server. Status reset to UNKNOWN.`,
            'info'
          );
        }
      }
    } else {
      this.log(
        'Skipping orphaned movie cleanup: no standard Radarr servers were scanned.',
        'info'
      );
    }

    if (this.didScan4k) {
      const processing4kMovies = await mediaRepository.find({
        where: {
          mediaType: MediaType.MOVIE,
          status4k: MediaStatus.PROCESSING,
        },
      });

      for (const media of processing4kMovies) {
        if (!this.scanned4kTmdbIds.has(media.tmdbId)) {
          media.status4k = MediaStatus.UNKNOWN;
          await mediaRepository.save(media);
          this.log(
            `Movie ${media.tmdbId} not found in any 4K Radarr server. 4K status reset to UNKNOWN.`,
            'info'
          );
        }
      }
    } else if (this.enable4kMovie) {
      this.log(
        'Skipping orphaned 4K movie cleanup: no 4K Radarr servers were scanned.',
        'info'
      );
    }
  }
}

export const radarrScanner = new RadarrScanner();
