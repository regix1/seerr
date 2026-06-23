import type { AllSettings } from '@server/lib/settings';

const AVAILABILITY_CHECK_DEFAULT = '0 */15 * * * *';

// The availability check job re-checks media still stuck in PROCESSING
// against its linked Radarr/Sonarr server and flips it to available, without a
// full library scan. Existing installs won't have the job key yet, so inject the
// default schedule so the job registers and appears in Jobs & Cache.
const migrateAvailabilityCheck = (settings: AllSettings): AllSettings => {
  const jobs = settings.jobs as
    | Record<string, { schedule: string }>
    | undefined;

  if (!jobs) {
    return settings;
  }

  if (!jobs['availability-check']) {
    jobs['availability-check'] = {
      schedule: AVAILABILITY_CHECK_DEFAULT,
    };
  }

  return settings;
};

export default migrateAvailabilityCheck;
