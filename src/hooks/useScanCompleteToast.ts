import defineMessages from '@app/utils/defineMessages';
import { useEffect, useRef } from 'react';
import { useIntl } from 'react-intl';
import { useToasts } from 'react-toast-notifications';

const messages = defineMessages('components.Settings', {
  scancomplete:
    '{provider} scan complete. {duplicates, plural, one {# duplicate} other {# duplicates}} skipped.',
});

type ScanProvider = 'Plex' | 'Jellyfin' | 'Emby';

interface ScanStatus {
  running: boolean;
  lastRunDuplicatesSkipped?: number;
  lastRunCompleted?: boolean;
}

/**
 * Fires a success toast when a manual scan transitions from running → complete.
 * Guards against firing on first mount (prevRunningRef starts as undefined).
 */
function useScanCompleteToast(
  provider: ScanProvider,
  syncStatus: ScanStatus | undefined
): void {
  const intl = useIntl();
  const { addToast } = useToasts();
  const prevRunningRef = useRef<boolean | undefined>(undefined);

  useEffect(() => {
    const currentRunning = syncStatus?.running ?? false;

    if (prevRunningRef.current === true && currentRunning === false) {
      const duplicates = syncStatus?.lastRunDuplicatesSkipped ?? 0;
      if (!syncStatus?.lastRunCompleted || duplicates === 0) {
        prevRunningRef.current = currentRunning;
        return;
      }
      addToast(
        intl.formatMessage(messages.scancomplete, {
          provider,
          duplicates,
        }),
        {
          autoDismiss: true,
          appearance: 'success',
        }
      );
    }

    prevRunningRef.current = currentRunning;
  }, [
    syncStatus?.running,
    syncStatus?.lastRunCompleted,
    syncStatus?.lastRunDuplicatesSkipped,
    provider,
    intl,
    addToast,
  ]);
}

export default useScanCompleteToast;
