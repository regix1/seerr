import type { DownloadingItem } from '@server/lib/downloadtracker';

export const refreshIntervalHelper = (
  downloadItem: {
    downloadStatus: DownloadingItem[] | undefined;
    downloadStatus4k: DownloadingItem[] | undefined;
    fileFlowsProcessing?: boolean;
  },
  timer: number
) => {
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
  return 0;
};
