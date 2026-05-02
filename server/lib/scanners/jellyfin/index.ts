import JellyfinAPI from '@server/api/jellyfin';
import { MediaServerType } from '@server/constants/server';
import {
  MediaServerScanner,
  type MediaServerSyncStatus,
} from '@server/lib/scanners/shared/mediaServerScanner';
import type { JellyfinSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';

class JellyfinScanner extends MediaServerScanner {
  constructor({ isRecentOnly }: { isRecentOnly?: boolean } = {}) {
    super(
      {
        settingsSelector: () => getSettings().jellyfin,
        gateFlag: 'jellyfinLoginEnabled',
        mediaServerType: MediaServerType.JELLYFIN,
        provider: 'jellyfin',
        apiFactory: (settings, token, deviceId) =>
          JellyfinAPI.forJellyfin(
            settings as JellyfinSettings,
            token,
            deviceId
          ),
        mediaIdField: 'jellyfinMediaId',
        mediaIdField4k: 'jellyfinMediaId4k',
        scannerLabel: 'Jellyfin',
      },
      { isRecentOnly }
    );
  }

  public status(): MediaServerSyncStatus {
    return super.status();
  }
}

export const jellyfinFullScanner = new JellyfinScanner();
export const jellyfinRecentScanner = new JellyfinScanner({
  isRecentOnly: true,
});

export default jellyfinFullScanner;
