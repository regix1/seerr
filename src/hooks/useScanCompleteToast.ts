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
  lastRunAt?: number;
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
  const previousRunAtRef = useRef<number | undefined>(undefined);
  const initializedRef = useRef(false);

  useEffect(() => {
    const lastRunAt = syncStatus?.lastRunAt;

    if (!initializedRef.current) {
      previousRunAtRef.current = lastRunAt;
      initializedRef.current = true;
      return;
    }

    if (
      lastRunAt &&
      lastRunAt !== previousRunAtRef.current &&
      !syncStatus?.running &&
      syncStatus.lastRunCompleted
    ) {
      addToast(
        intl.formatMessage(messages.scancomplete, {
          provider,
          duplicates: syncStatus.lastRunDuplicatesSkipped ?? 0,
        }),
        {
          autoDismiss: true,
          appearance: 'success',
        }
      );
      previousRunAtRef.current = lastRunAt;
    }
  }, [
    syncStatus?.running,
    syncStatus?.lastRunAt,
    syncStatus?.lastRunCompleted,
    syncStatus?.lastRunDuplicatesSkipped,
    provider,
    intl,
    addToast,
  ]);
}

export default useScanCompleteToast;
