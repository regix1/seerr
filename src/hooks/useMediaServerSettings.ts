import type { EmbySettings, JellyfinSettings } from '@server/lib/settings';
import axios from 'axios';
import { useState } from 'react';
import useSWR from 'swr';

type Provider = 'jellyfin' | 'emby';

interface SyncStatus {
  running: boolean;
  progress: number;
  total: number;
  currentLibrary?: {
    id: string;
    name: string;
    enabled: boolean;
  };
  libraries: {
    id: string;
    name: string;
    enabled: boolean;
  }[];
}

type ProviderSettings<T extends Provider> = T extends 'jellyfin'
  ? JellyfinSettings
  : EmbySettings;

interface UseMediaServerSettingsOptions<T extends Provider> {
  provider: T;
}

interface UseMediaServerSettingsResult<T extends Provider> {
  data: ProviderSettings<T> | undefined;
  error: unknown;
  mutate: () => void;
  syncData: SyncStatus | undefined;
  mutateSync: () => void;
  isSyncing: boolean;
  setIsSyncing: (value: boolean) => void;
  syncLibraries: (activeLibraries: string[]) => Promise<void>;
  toggleLibrary: (
    libraryId: string,
    activeLibraries: string[],
    onComplete?: () => void
  ) => Promise<void>;
  startScan: () => Promise<void>;
  cancelScan: () => Promise<void>;
}

function useMediaServerSettings<T extends Provider>(
  options: UseMediaServerSettingsOptions<T>
): UseMediaServerSettingsResult<T> {
  const { provider } = options;
  const [isSyncing, setIsSyncing] = useState(false);

  const { data, error, mutate } = useSWR<ProviderSettings<T>>(
    `/api/v1/settings/${provider}`
  );

  const { data: syncData, mutate: mutateSync } = useSWR<SyncStatus>(
    `/api/v1/settings/${provider}/sync`,
    { refreshInterval: 1000 }
  );

  const syncLibraries = async (activeLibraries: string[]): Promise<void> => {
    setIsSyncing(true);

    const params: { sync: boolean; enable?: string } = { sync: true };

    if (activeLibraries.length > 0) {
      params.enable = activeLibraries.join(',');
    }

    await axios.get(`/api/v1/settings/${provider}/library`, { params });
    setIsSyncing(false);
    mutate();
  };

  const toggleLibrary = async (
    libraryId: string,
    activeLibraries: string[],
    onComplete?: () => void
  ): Promise<void> => {
    setIsSyncing(true);

    if (activeLibraries.includes(libraryId)) {
      const params: { enable?: string } = {};

      if (activeLibraries.length > 1) {
        params.enable = activeLibraries
          .filter((id) => id !== libraryId)
          .join(',');
      }

      await axios.get(`/api/v1/settings/${provider}/library`, { params });
    } else {
      await axios.get(`/api/v1/settings/${provider}/library`, {
        params: {
          enable: [...activeLibraries, libraryId].join(','),
        },
      });
    }

    if (onComplete) {
      onComplete();
    }

    setIsSyncing(false);
    mutate();
  };

  const startScan = async (): Promise<void> => {
    await axios.post(`/api/v1/settings/${provider}/sync`, { start: true });
    mutateSync();
  };

  const cancelScan = async (): Promise<void> => {
    await axios.post(`/api/v1/settings/${provider}/sync`, { cancel: true });
    mutateSync();
  };

  return {
    data,
    error,
    mutate,
    syncData,
    mutateSync,
    isSyncing,
    setIsSyncing,
    syncLibraries,
    toggleLibrary,
    startScan,
    cancelScan,
  };
}

export default useMediaServerSettings;
