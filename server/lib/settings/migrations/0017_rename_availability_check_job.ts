import type { AllSettings } from '@server/lib/settings';

// The "availability-check" job was renamed to "download-completion-check".
// Existing installs persisted the old key (seeded by migration 0016), so move
// the user's schedule onto the new key and drop the stale one. We only copy
// when the new key isn't already present so we never clobber a user's schedule.
const migrateRenameAvailabilityCheckJob = (
  settings: AllSettings
): AllSettings => {
  const jobs = settings.jobs as
    | Record<string, { schedule: string }>
    | undefined;

  if (!jobs) {
    return settings;
  }

  if (jobs['availability-check']) {
    if (!jobs['download-completion-check']) {
      jobs['download-completion-check'] = jobs['availability-check'];
    }
    delete jobs['availability-check'];
  }

  return settings;
};

export default migrateRenameAvailabilityCheckJob;
