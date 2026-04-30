import { MediaServerType } from '@server/constants/server';
import type { AllSettings } from '@server/lib/settings';
import type { LegacySettings } from '@server/lib/settings/migrations/types';

const migrateHostname = (settings: LegacySettings): AllSettings => {
  const oldMediaServerType = settings.main.mediaServerType;
  if (
    oldMediaServerType === MediaServerType.JELLYFIN &&
    process.env.JELLYFIN_TYPE === 'emby'
  ) {
    settings.main.mediaServerType = MediaServerType.EMBY;
  }

  return settings;
};

export default migrateHostname;
