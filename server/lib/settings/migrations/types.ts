import type { AllSettings } from '@server/lib/settings';

export type LegacySettings = AllSettings & {
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
  notifications: AllSettings['notifications'] & {
    agents: AllSettings['notifications']['agents'] & { lunasea?: unknown };
  };
};
