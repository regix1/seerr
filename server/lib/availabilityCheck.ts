import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { radarrScanner } from '@server/lib/scanners/radarr';
import { sonarrScanner } from '@server/lib/scanners/sonarr';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { MoreThan } from 'typeorm';

const PAGE_SIZE = 50;

interface AvailabilityCheckStatus {
  running: boolean;
}

/**
 * AvailabilityCheck
 *
 * A lightweight, user-scheduled job that re-checks media still stuck in
 * PROCESSING against its linked Radarr/Sonarr server and flips it to
 * AVAILABLE/PARTIALLY_AVAILABLE as soon as the *arr import has completed -
 * without running a full library scan.
 *
 * It does NOT re-implement any status/FileFlows/season logic: it reuses the
 * existing scanner singletons' per-item path (radarrScanner.checkPendingMovie
 * / sonarrScanner.checkPendingSeries), which save via the media repository
 * and therefore fire the MEDIA_AVAILABLE notification through the
 * MediaSubscriber cascade for free. It only ever upgrades PROCESSING media; it
 * never downgrades or deletes.
 */
class AvailabilityCheck {
  private running = false;

  public status(): AvailabilityCheckStatus {
    return { running: this.running };
  }

  public cancel(): void {
    this.running = false;
  }

  public async run(): Promise<void> {
    if (this.running) {
      logger.warn('Availability check is already running. Skipping.', {
        label: 'Availability Check',
      });
      return;
    }

    const settings = getSettings();

    // Default behavior matches the bulk scanners: only check items on
    // sync-enabled servers. Disabling sync on a server intentionally opts it
    // out of availability changes. When `includeDisabledServers` is enabled,
    // the availability check ALSO re-checks items on sync-disabled servers
    // (the bulk scanners still skip them).
    const includeDisabledServers = settings.main.includeDisabledServers;
    const radarrServers = new Map<number, RadarrSettings>(
      settings.radarr
        .filter((server) => includeDisabledServers || server.syncEnabled)
        .map((server) => [server.id, server])
    );
    const sonarrServers = new Map<number, SonarrSettings>(
      settings.sonarr
        .filter((server) => includeDisabledServers || server.syncEnabled)
        .map((server) => [server.id, server])
    );

    this.running = true;
    logger.info('Starting availability check.', {
      label: 'Availability Check',
    });

    try {
      for await (const media of this.loadProcessingMediaPaginated(PAGE_SIZE)) {
        if (!this.running) {
          logger.info('Availability check was canceled.', {
            label: 'Availability Check',
          });
          break;
        }

        try {
          if (media.mediaType === MediaType.MOVIE) {
            await this.checkMovie(media, radarrServers);
          } else {
            await this.checkSeries(media, sonarrServers);
          }
        } catch (e) {
          // Fail open per item: log and continue with the rest of the batch.
          logger.error('Failed to check media item.', {
            label: 'Availability Check',
            errorMessage: e.message,
            mediaId: media.id,
            tmdbId: media.tmdbId,
          });
        }
      }

      logger.info('Availability check complete.', {
        label: 'Availability Check',
      });
    } catch (e) {
      logger.error('Availability check interrupted.', {
        label: 'Availability Check',
        errorMessage: e.message,
      });
    } finally {
      this.running = false;
    }
  }

  private async checkMovie(
    media: Media,
    radarrServers: Map<number, RadarrSettings>
  ): Promise<void> {
    // Standard (non-4k) link.
    if (
      media.status === MediaStatus.PROCESSING &&
      media.serviceId != null &&
      media.externalServiceId != null
    ) {
      const server = radarrServers.get(media.serviceId);
      if (server) {
        await radarrScanner.checkPendingMovie(
          server,
          media.externalServiceId,
          false
        );
      }
    }

    // 4k link.
    if (
      media.status4k === MediaStatus.PROCESSING &&
      media.serviceId4k != null &&
      media.externalServiceId4k != null
    ) {
      const server = radarrServers.get(media.serviceId4k);
      if (server) {
        await radarrScanner.checkPendingMovie(
          server,
          media.externalServiceId4k,
          true
        );
      }
    }
  }

  private async checkSeries(
    media: Media,
    sonarrServers: Map<number, SonarrSettings>
  ): Promise<void> {
    const standardProcessing =
      media.status === MediaStatus.PROCESSING ||
      media.seasons.some((season) => season.status === MediaStatus.PROCESSING);
    const fourkProcessing =
      media.status4k === MediaStatus.PROCESSING ||
      media.seasons.some(
        (season) => season.status4k === MediaStatus.PROCESSING
      );

    // Standard (non-4k) link.
    if (
      standardProcessing &&
      media.serviceId != null &&
      media.externalServiceId != null
    ) {
      const server = sonarrServers.get(media.serviceId);
      if (server) {
        await sonarrScanner.checkPendingSeries(
          server,
          media.externalServiceId,
          false
        );
      }
    }

    // 4k link.
    if (
      fourkProcessing &&
      media.serviceId4k != null &&
      media.externalServiceId4k != null
    ) {
      const server = sonarrServers.get(media.serviceId4k);
      if (server) {
        await sonarrScanner.checkPendingSeries(
          server,
          media.externalServiceId4k,
          true
        );
      }
    }
  }

  /**
   * Inverse of availabilitySync's loadAvailableMediaPaginated: load only media
   * still in PROCESSING (top-level status, status4k, or any season). PENDING,
   * BLOCKLISTED and DELETED are excluded because they are not represented by
   * MediaStatus.PROCESSING.
   */
  private async *loadProcessingMediaPaginated(
    pageSize: number
  ): AsyncGenerator<Media> {
    const mediaRepository = getRepository(Media);

    // Cursor (keyset) pagination on the ascending id, NOT a fixed offset.
    // Items leave PROCESSING as the check upgrades them, so a `skip: offset`
    // window would shift left under us and silently skip rows. Paging by
    // `id > lastId` is stable against the result set shrinking mid-run.
    let lastId = 0;
    let mediaPage: Media[];

    do {
      const whereOptions = [
        { id: MoreThan(lastId), status: MediaStatus.PROCESSING },
        { id: MoreThan(lastId), status4k: MediaStatus.PROCESSING },
        { id: MoreThan(lastId), seasons: { status: MediaStatus.PROCESSING } },
        {
          id: MoreThan(lastId),
          seasons: { status4k: MediaStatus.PROCESSING },
        },
      ];

      mediaPage = await mediaRepository.find({
        where: whereOptions,
        relations: { seasons: true },
        take: pageSize,
        order: { id: 'ASC' },
      });

      for (const media of mediaPage) {
        yield media;
      }

      if (mediaPage.length > 0) {
        lastId = mediaPage[mediaPage.length - 1].id;
      }
    } while (mediaPage.length === pageSize);
  }
}

export const availabilityCheck = new AvailabilityCheck();

export default availabilityCheck;
