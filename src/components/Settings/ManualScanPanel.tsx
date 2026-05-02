import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import { MagnifyingGlassIcon, XMarkIcon } from '@heroicons/react/24/solid';

interface ManualScanLibrary {
  id: string;
  name: string;
  enabled: boolean;
}

export interface ManualScanStatus {
  running: boolean;
  progress: number;
  total: number;
  currentLibrary?: ManualScanLibrary;
  libraries: ManualScanLibrary[];
  duplicatesSkipped?: number;
}

interface ManualScanPanelProps {
  syncStatus?: ManualScanStatus;
  startDisabled?: boolean;
  onStart: () => void;
  onCancel: () => void;
  labels: {
    notRunning: string;
    startScan: string;
    cancelScan: string;
    currentLibrary: (name: string) => string;
    librariesRemaining: (count: number) => string;
    duplicatesSkipped: (count: number) => string;
  };
}

const ManualScanPanel = ({
  syncStatus,
  startDisabled = false,
  onStart,
  onCancel,
  labels,
}: ManualScanPanelProps) => {
  const progressPercent =
    syncStatus?.total && syncStatus.total > 0
      ? Math.round((syncStatus.progress / syncStatus.total) * 100)
      : 0;

  const remainingLibraries = syncStatus?.currentLibrary
    ? syncStatus.libraries.slice(
        syncStatus.libraries.findIndex(
          (library) => library.id === syncStatus.currentLibrary?.id
        ) + 1
      ).length
    : 0;

  return (
    <div className="section">
      <div className="rounded-md bg-gray-800 p-4">
        <div className="relative mb-6 h-8 w-full overflow-hidden rounded-full bg-gray-600">
          {syncStatus?.running && (
            <div
              className="h-8 bg-indigo-600 transition-all duration-200 ease-in-out"
              style={{ width: `${progressPercent}%` }}
            />
          )}
          <div className="absolute inset-0 flex h-8 w-full items-center justify-center text-sm">
            <span>
              {syncStatus?.running
                ? `${syncStatus.progress} of ${syncStatus.total}`
                : labels.notRunning}
            </span>
          </div>
        </div>
        <div className="flex w-full flex-col sm:flex-row">
          {syncStatus?.running && (
            <>
              {syncStatus.currentLibrary && (
                <div className="mb-2 mr-0 flex items-center sm:mb-0 sm:mr-2">
                  <Badge>
                    {labels.currentLibrary(syncStatus.currentLibrary.name)}
                  </Badge>
                </div>
              )}
              <div className="flex items-center">
                <Badge badgeType="warning">
                  {labels.librariesRemaining(remainingLibraries)}
                </Badge>
              </div>
              {(syncStatus.duplicatesSkipped ?? 0) > 0 && (
                <div className="ml-0 mt-2 flex items-center sm:ml-2 sm:mt-0">
                  <Badge badgeType="primary">
                    {labels.duplicatesSkipped(
                      syncStatus.duplicatesSkipped ?? 0
                    )}
                  </Badge>
                </div>
              )}
            </>
          )}
          <div className="flex-1 text-right">
            {!syncStatus?.running ? (
              <Button
                buttonType="warning"
                onClick={() => onStart()}
                disabled={startDisabled}
              >
                <MagnifyingGlassIcon />
                <span>{labels.startScan}</span>
              </Button>
            ) : (
              <Button buttonType="danger" onClick={() => onCancel()}>
                <XMarkIcon />
                <span>{labels.cancelScan}</span>
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ManualScanPanel;
