import type { AllSettings } from '@server/lib/settings';
import type { LegacySettings } from '@server/lib/settings/migrations/types';

const removeLunaSeaSetting = (settings: LegacySettings): AllSettings => {
  if (
    settings.notifications &&
    settings.notifications.agents &&
    settings.notifications.agents.lunasea
  ) {
    delete settings.notifications.agents.lunasea;
  }
  return settings;
};

export default removeLunaSeaSetting;
