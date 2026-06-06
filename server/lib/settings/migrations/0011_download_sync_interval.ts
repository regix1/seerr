import type { AllSettings } from '@server/lib/settings';

const OLD_DEFAULT_SCHEDULE = '0 * * * * *';
const NEW_DEFAULT_SCHEDULE = '*/5 * * * * *';

// The download-sync job feeds the download progress bar / ETA. At the old
// once-a-minute default the bar barely moves between polls (especially for fast
// usenet grabs), so the live ETA appears to race ahead of it. Bump installs
// that are still on the old default to the new, more responsive default while
// leaving any user-customized schedule untouched.
const migrateDownloadSyncInterval = (settings: AllSettings): AllSettings => {
  const jobs = settings.jobs as
    | Record<string, { schedule: string }>
    | undefined;

  if (jobs && jobs['download-sync']?.schedule === OLD_DEFAULT_SCHEDULE) {
    jobs['download-sync'].schedule = NEW_DEFAULT_SCHEDULE;
  }

  return settings;
};

export default migrateDownloadSyncInterval;
