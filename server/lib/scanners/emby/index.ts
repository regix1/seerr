import JellyfinAPI from '@server/api/jellyfin';
import { MediaServerType } from '@server/constants/server';
import {
  MediaServerScanner,
  type MediaServerSyncStatus,
} from '@server/lib/scanners/shared/mediaServerScanner';
import type { EmbySettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';

class EmbyScanner extends MediaServerScanner {
  constructor({ isRecentOnly }: { isRecentOnly?: boolean } = {}) {
    super(
      {
        settingsSelector: () => getSettings().emby,
        gateFlag: 'embyLoginEnabled',
        mediaServerType: MediaServerType.EMBY,
        apiFactory: (settings, token, deviceId) =>
          JellyfinAPI.forEmby(settings as EmbySettings, token, deviceId),
        mediaIdField: 'embyMediaId',
        mediaIdField4k: 'embyMediaId4k',
        scannerLabel: 'Emby',
      },
      { isRecentOnly }
    );
  }

  public status(): MediaServerSyncStatus {
    return super.status();
  }
}

export const embyFullScanner = new EmbyScanner();
export const embyRecentScanner = new EmbyScanner({ isRecentOnly: true });

export default embyFullScanner;
