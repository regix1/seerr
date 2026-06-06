import type { AllSettings } from '@server/lib/settings';

const migrateFileFlowsAvailabilitySync = (
  settings: AllSettings
): AllSettings => {
  const fileflows = settings.fileflows as
    | { availabilitySync?: string }
    | undefined;

  if (fileflows && fileflows.availabilitySync == null) {
    fileflows.availabilitySync = 'schedule';
  }

  return settings;
};

export default migrateFileFlowsAvailabilitySync;
