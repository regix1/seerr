import type { AllSettings } from '@server/lib/settings';

const RADARR_DAILY_DEFAULT = '0 0 4 * * *';
const SONARR_DAILY_DEFAULT = '0 30 4 * * *';
const RADARR_HOURLY_DEFAULT = '0 */60 * * * *';
const SONARR_STAGGERED_HOURLY_DEFAULT = '0 30 * * * *';

// Radarr/Sonarr scans are now minute-interval jobs (editable in Jobs & Cache).
// Move installs still on the old once-daily defaults to hourly so FileFlows
// availability is picked up without the fileflows-sync job driving full scans.
const migrateArrScanInterval = (settings: AllSettings): AllSettings => {
  const jobs = settings.jobs as
    | Record<string, { schedule: string }>
    | undefined;

  if (!jobs) {
    return settings;
  }

  if (jobs['radarr-scan']?.schedule === RADARR_DAILY_DEFAULT) {
    jobs['radarr-scan'].schedule = RADARR_HOURLY_DEFAULT;
  }

  if (jobs['sonarr-scan']?.schedule === SONARR_DAILY_DEFAULT) {
    jobs['sonarr-scan'].schedule = SONARR_STAGGERED_HOURLY_DEFAULT;
  }

  return settings;
};

export default migrateArrScanInterval;
