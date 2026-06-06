import { MediaStatus } from '@server/constants/media';
import type { DownloadingItem } from '@server/lib/downloadtracker';

export interface MediaPollingState {
  downloadStatus?: DownloadingItem[];
  downloadStatus4k?: DownloadingItem[];
  fileFlowsProcessing?: boolean;
  status?: MediaStatus;
  status4k?: MediaStatus;
}

const isTransitionalStatus = (status?: MediaStatus): boolean =>
  status === MediaStatus.PROCESSING || status === MediaStatus.PENDING;

export const mediaPollingState = (
  mediaInfo?: MediaPollingState | null
): MediaPollingState => ({
  downloadStatus: mediaInfo?.downloadStatus,
  downloadStatus4k: mediaInfo?.downloadStatus4k,
  fileFlowsProcessing: mediaInfo?.fileFlowsProcessing,
  status: mediaInfo?.status,
  status4k: mediaInfo?.status4k,
});

export const refreshIntervalHelper = (
  downloadItem: MediaPollingState,
  timer: number
): number => {
  if (
    (downloadItem.downloadStatus ?? []).length > 0 ||
    (downloadItem.downloadStatus4k ?? []).length > 0
  ) {
    return timer;
  }
  // FileFlows post-processing has no download item to drive polling, so poll a
  // bit faster than downloads to keep the live processing percent current.
  if (downloadItem.fileFlowsProcessing) {
    return Math.min(timer, 3000);
  }
  // Keep polling while status is still transitional so discover/title cards
  // pick up the flip to AVAILABLE after FileFlows finishes and a scan runs.
  if (
    isTransitionalStatus(downloadItem.status) ||
    isTransitionalStatus(downloadItem.status4k)
  ) {
    return timer;
  }
  return 0;
};
