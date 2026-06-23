import { MediaServerType } from '@server/constants/server';
import blocklistedTagsProcessor from '@server/job/blocklistedTagsProcessor';
import availabilitySync from '@server/lib/availabilitySync';
import downloadCompletionCheck from '@server/lib/downloadCompletionCheck';
import downloadTracker from '@server/lib/downloadtracker';
import fileFlowsTracker from '@server/lib/fileflows';
import ImageProxy from '@server/lib/imageproxy';
import refreshToken from '@server/lib/refreshToken';
import { embyFullScanner, embyRecentScanner } from '@server/lib/scanners/emby';
import {
  jellyfinFullScanner,
  jellyfinRecentScanner,
} from '@server/lib/scanners/jellyfin';
import { plexFullScanner, plexRecentScanner } from '@server/lib/scanners/plex';
import { radarrScanner } from '@server/lib/scanners/radarr';
import { sonarrScanner } from '@server/lib/scanners/sonarr';
import type { JobId } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import watchlistSync from '@server/lib/watchlistsync';
import logger from '@server/logger';
import schedule from 'node-schedule';

interface ScheduledJob {
  id: JobId;
  job: schedule.Job;
  name: string;
  type: 'process' | 'command';
  interval: 'seconds' | 'minutes' | 'hours' | 'days' | 'fixed';
  cronSchedule: string;
  running?: () => boolean;
  cancelFn?: () => void;
}

export const scheduledJobs: ScheduledJob[] = [];

export const startJobs = (): void => {
  const jobs = getSettings().jobs;
  const {
    mediaServerType,
    plexLoginEnabled,
    jellyfinLoginEnabled,
    embyLoginEnabled,
  } = getSettings().main;

  if (plexLoginEnabled || mediaServerType === MediaServerType.PLEX) {
    // Run recently added plex scan every 5 minutes
    scheduledJobs.push({
      id: 'plex-recently-added-scan',
      name: 'Plex Recently Added Scan',
      type: 'process',
      interval: 'minutes',
      cronSchedule: jobs['plex-recently-added-scan'].schedule,
      job: schedule.scheduleJob(
        jobs['plex-recently-added-scan'].schedule,
        () => {
          logger.info('Starting scheduled job: Plex Recently Added Scan', {
            label: 'Jobs',
          });
          plexRecentScanner.run();
        }
      ),
      running: () => plexRecentScanner.status().running,
      cancelFn: () => plexRecentScanner.cancel(),
    });

    // Run full plex scan every 24 hours
    scheduledJobs.push({
      id: 'plex-full-scan',
      name: 'Plex Full Library Scan',
      type: 'process',
      interval: 'hours',
      cronSchedule: jobs['plex-full-scan'].schedule,
      job: schedule.scheduleJob(jobs['plex-full-scan'].schedule, () => {
        logger.info('Starting scheduled job: Plex Full Library Scan', {
          label: 'Jobs',
        });
        plexFullScanner.run();
      }),
      running: () => plexFullScanner.status().running,
      cancelFn: () => plexFullScanner.cancel(),
    });

    scheduledJobs.push({
      id: 'plex-refresh-token',
      name: 'Plex Refresh Token',
      type: 'process',
      interval: 'fixed',
      cronSchedule: jobs['plex-refresh-token'].schedule,
      job: schedule.scheduleJob(jobs['plex-refresh-token'].schedule, () => {
        logger.info('Starting scheduled job: Plex Refresh Token', {
          label: 'Jobs',
        });
        refreshToken.run();
      }),
    });

    // Watchlist Sync
    scheduledJobs.push({
      id: 'plex-watchlist-sync',
      name: 'Plex Watchlist Sync',
      type: 'process',
      interval: 'minutes',
      cronSchedule: jobs['plex-watchlist-sync'].schedule,
      job: schedule.scheduleJob(jobs['plex-watchlist-sync'].schedule, () => {
        logger.info('Starting scheduled job: Plex Watchlist Sync', {
          label: 'Jobs',
        });
        watchlistSync.syncWatchlist().catch((e) => {
          logger.error('Failed to sync watchlists', {
            label: 'Plex Watchlist Sync',
            errorMessage: e.message,
          });
        });
      }),
    });
  }

  if (jellyfinLoginEnabled || mediaServerType === MediaServerType.JELLYFIN) {
    // Run recently added jellyfin sync every 5 minutes
    scheduledJobs.push({
      id: 'jellyfin-recently-added-scan',
      name: 'Jellyfin Recently Added Scan',
      type: 'process',
      interval: 'minutes',
      cronSchedule: jobs['jellyfin-recently-added-scan'].schedule,
      job: schedule.scheduleJob(
        jobs['jellyfin-recently-added-scan'].schedule,
        () => {
          logger.info('Starting scheduled job: Jellyfin Recently Added Scan', {
            label: 'Jobs',
          });
          jellyfinRecentScanner.run();
        }
      ),
      running: () => jellyfinRecentScanner.status().running,
      cancelFn: () => jellyfinRecentScanner.cancel(),
    });

    // Run full jellyfin sync every 24 hours
    scheduledJobs.push({
      id: 'jellyfin-full-scan',
      name: 'Jellyfin Full Library Scan',
      type: 'process',
      interval: 'hours',
      cronSchedule: jobs['jellyfin-full-scan'].schedule,
      job: schedule.scheduleJob(jobs['jellyfin-full-scan'].schedule, () => {
        logger.info('Starting scheduled job: Jellyfin Full Scan', {
          label: 'Jobs',
        });
        jellyfinFullScanner.run();
      }),
      running: () => jellyfinFullScanner.status().running,
      cancelFn: () => jellyfinFullScanner.cancel(),
    });
  }

  if (embyLoginEnabled || mediaServerType === MediaServerType.EMBY) {
    scheduledJobs.push({
      id: 'emby-recently-added-scan',
      name: 'Emby Recently Added Scan',
      type: 'process',
      interval: 'minutes',
      cronSchedule: jobs['emby-recently-added-scan'].schedule,
      job: schedule.scheduleJob(
        jobs['emby-recently-added-scan'].schedule,
        () => {
          logger.info('Starting scheduled job: Emby Recently Added Scan', {
            label: 'Jobs',
          });
          embyRecentScanner.run();
        }
      ),
      running: () => embyRecentScanner.status().running,
      cancelFn: () => embyRecentScanner.cancel(),
    });

    scheduledJobs.push({
      id: 'emby-full-scan',
      name: 'Emby Full Library Scan',
      type: 'process',
      interval: 'hours',
      cronSchedule: jobs['emby-full-scan'].schedule,
      job: schedule.scheduleJob(jobs['emby-full-scan'].schedule, () => {
        logger.info('Starting scheduled job: Emby Full Scan', {
          label: 'Jobs',
        });
        embyFullScanner.run();
      }),
      running: () => embyFullScanner.status().running,
      cancelFn: () => embyFullScanner.cancel(),
    });
  }

  // Full Radarr library scan; frequency is user-configurable (Jobs & Cache).
  scheduledJobs.push({
    id: 'radarr-scan',
    name: 'Radarr Scan',
    type: 'process',
    interval: 'minutes',
    cronSchedule: jobs['radarr-scan'].schedule,
    job: schedule.scheduleJob(jobs['radarr-scan'].schedule, () => {
      logger.info('Starting scheduled job: Radarr Scan', { label: 'Jobs' });
      radarrScanner.run();
    }),
    running: () => radarrScanner.status().running,
    cancelFn: () => radarrScanner.cancel(),
  });

  // Full Sonarr library scan; frequency is user-configurable (Jobs & Cache).
  scheduledJobs.push({
    id: 'sonarr-scan',
    name: 'Sonarr Scan',
    type: 'process',
    interval: 'minutes',
    cronSchedule: jobs['sonarr-scan'].schedule,
    job: schedule.scheduleJob(jobs['sonarr-scan'].schedule, () => {
      logger.info('Starting scheduled job: Sonarr Scan', { label: 'Jobs' });
      sonarrScanner.run();
    }),
    running: () => sonarrScanner.status().running,
    cancelFn: () => sonarrScanner.cancel(),
  });

  // Checks if media is still available in plex/sonarr/radarr libs
  scheduledJobs.push({
    id: 'availability-sync',
    name: 'Media Availability Sync',
    type: 'process',
    interval: 'hours',
    cronSchedule: jobs['availability-sync'].schedule,
    job: schedule.scheduleJob(jobs['availability-sync'].schedule, () => {
      logger.info('Starting scheduled job: Media Availability Sync', {
        label: 'Jobs',
      });
      availabilitySync.run();
    }),
    running: () => availabilitySync.running,
    cancelFn: () => availabilitySync.cancel(),
  });

  // Re-check media still stuck in PROCESSING against its linked Radarr/Sonarr
  // server and flip it to available without a full library scan; frequency is
  // user-configurable (Jobs & Cache).
  scheduledJobs.push({
    id: 'download-completion-check',
    name: 'Download Completion Check',
    type: 'process',
    interval: 'minutes',
    cronSchedule: jobs['download-completion-check'].schedule,
    job: schedule.scheduleJob(
      jobs['download-completion-check'].schedule,
      () => {
        logger.info('Starting scheduled job: Download Completion Check', {
          label: 'Jobs',
        });
        downloadCompletionCheck.run();
      }
    ),
    running: () => downloadCompletionCheck.status().running,
    cancelFn: () => downloadCompletionCheck.cancel(),
  });

  // Run download sync every minute
  scheduledJobs.push({
    id: 'download-sync',
    name: 'Download Sync',
    type: 'command',
    interval: 'seconds',
    cronSchedule: jobs['download-sync'].schedule,
    job: schedule.scheduleJob(jobs['download-sync'].schedule, () => {
      logger.debug('Starting scheduled job: Download Sync', {
        label: 'Jobs',
      });
      downloadTracker.updateDownloads();
    }),
  });

  // Re-check FileFlows post-processing. Always refreshes holds/badges; when
  // availabilitySync is `active`, also triggers Radarr/Sonarr scans while
  // FileFlows is processing or media is still held (see FileFlows settings).
  const fileFlowsSettings = getSettings().fileflows;
  let releaseRadarrScan =
    fileFlowsSettings.enabled &&
    fileFlowsSettings.availabilitySync === 'active';
  let releaseSonarrScan = releaseRadarrScan;
  scheduledJobs.push({
    id: 'fileflows-sync',
    name: 'FileFlows Sync',
    type: 'command',
    interval: 'seconds',
    cronSchedule: jobs['fileflows-sync'].schedule,
    job: schedule.scheduleJob(jobs['fileflows-sync'].schedule, async () => {
      await fileFlowsTracker.resolveHeldMedia();

      const { enabled, availabilitySync } = getSettings().fileflows;
      if (!enabled || availabilitySync !== 'active') {
        return;
      }

      const processing = await fileFlowsTracker.hasProcessingFiles();

      if (processing || fileFlowsTracker.hasHeldMedia()) {
        releaseRadarrScan = true;
        releaseSonarrScan = true;
        logger.info(
          'FileFlows post-processing active; running scan to refresh availability',
          { label: 'Jobs' }
        );
        if (!radarrScanner.status().running) {
          radarrScanner.run();
        }
        if (!sonarrScanner.status().running) {
          sonarrScanner.run();
        }
        return;
      }

      if (releaseRadarrScan && !radarrScanner.status().running) {
        releaseRadarrScan = false;
        logger.info('FileFlows idle; running scan to release availability', {
          label: 'Jobs',
        });
        radarrScanner.run();
      }
      if (releaseSonarrScan && !sonarrScanner.status().running) {
        releaseSonarrScan = false;
        sonarrScanner.run();
      }
    }),
  });

  // Reset download sync everyday at 01:00 am
  scheduledJobs.push({
    id: 'download-sync-reset',
    name: 'Download Sync Reset',
    type: 'command',
    interval: 'hours',
    cronSchedule: jobs['download-sync-reset'].schedule,
    job: schedule.scheduleJob(jobs['download-sync-reset'].schedule, () => {
      logger.info('Starting scheduled job: Download Sync Reset', {
        label: 'Jobs',
      });
      downloadTracker.resetDownloadTracker();
    }),
  });

  // Run image cache cleanup every 24 hours
  scheduledJobs.push({
    id: 'image-cache-cleanup',
    name: 'Image Cache Cleanup',
    type: 'process',
    interval: 'hours',
    cronSchedule: jobs['image-cache-cleanup'].schedule,
    job: schedule.scheduleJob(jobs['image-cache-cleanup'].schedule, () => {
      logger.info('Starting scheduled job: Image Cache Cleanup', {
        label: 'Jobs',
      });
      // Clean TMDB image cache
      ImageProxy.clearCache('tmdb');

      // Clean users avatar image cache
      ImageProxy.clearCache('avatar');
    }),
  });

  scheduledJobs.push({
    id: 'process-blocklisted-tags',
    name: 'Process Blocklisted Tags',
    type: 'process',
    interval: 'days',
    cronSchedule: jobs['process-blocklisted-tags'].schedule,
    job: schedule.scheduleJob(jobs['process-blocklisted-tags'].schedule, () => {
      logger.info('Starting scheduled job: Process Blocklisted Tags', {
        label: 'Jobs',
      });
      blocklistedTagsProcessor.run();
    }),
    running: () => blocklistedTagsProcessor.status().running,
    cancelFn: () => blocklistedTagsProcessor.cancel(),
  });

  logger.info('Scheduled jobs loaded', { label: 'Jobs' });
};
