import { MediaServerType } from '@server/constants/server';
import type { AllSettings } from '@server/lib/settings';
import type { LegacySettings } from '@server/lib/settings/migrations/types';

const migrateDualAuthLoginFlags = (settings: LegacySettings): AllSettings => {
  if (
    Array.isArray(settings.migrations) &&
    settings.migrations.includes('0009_dual_auth_login_flags')
  ) {
    return settings;
  }

  // Idempotent: only set flags if they aren't already present
  if (
    settings.main.plexLoginEnabled === undefined ||
    settings.main.jellyfinLoginEnabled === undefined
  ) {
    const mediaServerType = settings.main.mediaServerType;

    if (mediaServerType === MediaServerType.PLEX) {
      settings.main.plexLoginEnabled = true;
      settings.main.jellyfinLoginEnabled = false;
    } else if (
      mediaServerType === MediaServerType.JELLYFIN ||
      mediaServerType === MediaServerType.EMBY
    ) {
      settings.main.plexLoginEnabled = false;
      settings.main.jellyfinLoginEnabled = true;
    } else {
      // NOT_CONFIGURED (4) or any unknown value
      settings.main.plexLoginEnabled = false;
      settings.main.jellyfinLoginEnabled = false;
    }
  }

  if (!Array.isArray(settings.migrations)) {
    settings.migrations = [];
  }
  settings.migrations.push('0009_dual_auth_login_flags');

  return settings;
};

export default migrateDualAuthLoginFlags;
