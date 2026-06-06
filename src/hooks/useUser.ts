import { UserType } from '@server/constants/user';
import type { PermissionCheckOptions } from '@server/lib/permissions';
import {
  hasPermission,
  Permission,
  Permission2,
} from '@server/lib/permissions';
import type { NotificationAgentKey } from '@server/lib/settings';
import axios from 'axios';
import { useRouter } from 'next/router';
import type { MutatorCallback } from 'swr';
import useSWR from 'swr';

export { Permission, Permission2, UserType };
export type { PermissionCheckOptions };

export interface MediaServerLoginPayload {
  username: string;
  password: string;
  hostname?: string;
  port?: number;
  urlBase?: string;
  useSsl?: boolean;
  email?: string;
}

export interface PlexLoginPayload {
  authToken: string;
}

/**
 * POST credentials to `/api/v1/auth/plex`. Returns the authenticated user payload.
 */
export const loginWithPlex = async (
  payload: PlexLoginPayload
): Promise<User> => {
  const response = await axios.post<User>('/api/v1/auth/plex', payload);
  return response.data;
};

/**
 * POST credentials to `/api/v1/auth/jellyfin`. Returns the authenticated user payload.
 * Requires `settings.main.jellyfinLoginEnabled === true` server-side.
 */
export const loginWithJellyfin = async (
  payload: MediaServerLoginPayload
): Promise<User> => {
  const response = await axios.post<User>('/api/v1/auth/jellyfin', payload);
  return response.data;
};

/**
 * POST credentials to `/api/v1/auth/emby`. Returns the authenticated user payload.
 * Requires `settings.main.embyLoginEnabled === true` server-side.
 */
export const loginWithEmby = async (
  payload: MediaServerLoginPayload
): Promise<User> => {
  const response = await axios.post<User>('/api/v1/auth/emby', payload);
  return response.data;
};

export interface User {
  id: number;
  warnings: string[];
  plexUsername?: string | null;
  jellyfinUsername?: string | null;
  embyUserId?: string | null;
  embyUsername?: string | null;
  username?: string;
  displayName: string;
  email: string;
  avatar: string;
  permissions: number;
  permissions2: number;
  userType: number;
  createdAt: Date;
  updatedAt: Date;
  requestCount: number;
  linkedProviders?: string[];
  settings?: UserSettings;
}

type NotificationAgentTypes = Record<NotificationAgentKey, number>;

export interface UserSettings {
  discoverRegion?: string;
  streamingRegion?: string;
  originalLanguage?: string;
  locale?: string;
  notificationTypes: Partial<NotificationAgentTypes>;
  watchlistSyncMovies?: boolean;
  watchlistSyncTv?: boolean;
}

interface UserHookResponse {
  user?: User;
  loading: boolean;
  error: string;
  revalidate: (
    data?: User | Promise<User> | MutatorCallback<User> | undefined,
    shouldRevalidate?: boolean | undefined
  ) => Promise<User | undefined>;
  hasPermission: (
    permission: Permission | Permission2 | (Permission | Permission2)[],
    options?: PermissionCheckOptions
  ) => boolean;
}

export const useUser = ({
  id,
  initialData,
}: { id?: number; initialData?: User } = {}): UserHookResponse => {
  const router = useRouter();
  const isAuthPage = /^\/(login|setup|resetpassword(?:\/|$))/.test(
    router.pathname
  );

  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<User>(id ? `/api/v1/user/${id}` : `/api/v1/auth/me`, {
    fallbackData: initialData,
    refreshInterval: !isAuthPage ? 30000 : 0,
    revalidateOnFocus: !isAuthPage,
    revalidateOnMount: !isAuthPage,
    revalidateOnReconnect: !isAuthPage,
    errorRetryInterval: 30000,
    shouldRetryOnError: false,
  });

  const checkPermission = (
    permission: Permission | Permission2 | (Permission | Permission2)[],
    options?: PermissionCheckOptions
  ): boolean => {
    return hasPermission(
      permission as Permission | Permission[],
      data?.permissions ?? 0,
      data?.permissions2 ?? 0,
      options
    );
  };

  return {
    user: data,
    loading: !data && !error,
    error,
    hasPermission: checkPermission,
    revalidate,
  };
};
