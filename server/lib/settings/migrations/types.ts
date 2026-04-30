import type { AllSettings } from '@server/lib/settings';

interface LegacyJobSettings {
  schedule: string;
}

export type LegacySettings = Omit<
  AllSettings,
  'jobs' | 'notifications' | 'network'
> & {
  main: AllSettings['main'] & {
    region?: string;
    csrfProtection?: boolean;
    trustProxy?: boolean;
    forceIpv4First?: boolean;
    proxy?: unknown;
    hideBlacklisted?: boolean;
    blacklistedTags?: string;
    blacklistedTagsLimit?: number;
    hideBlocklisted?: boolean;
    blocklistedTags?: string;
    blocklistedTagsLimit?: number;
  };
  jellyfin: AllSettings['jellyfin'] & { hostname?: string };
  notifications: Omit<AllSettings['notifications'], 'agents'> & {
    agents: AllSettings['notifications']['agents'] & { lunasea?: unknown };
  };
  network?: Record<string, unknown>;
  jobs?: Record<string, LegacyJobSettings>;
};
