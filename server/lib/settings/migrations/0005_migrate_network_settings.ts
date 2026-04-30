import type { AllSettings } from '@server/lib/settings';
import type { LegacySettings } from '@server/lib/settings/migrations/types';

const migrateNetworkSettings = (settings: LegacySettings): AllSettings => {
  if (settings.network) {
    return settings;
  }
  const newSettings = { ...settings };
  newSettings.network = {
    ...((settings.network ?? {}) as Record<string, unknown>),
    csrfProtection: settings.main.csrfProtection ?? false,
    trustProxy: settings.main.trustProxy ?? false,
    forceIpv4First: settings.main.forceIpv4First ?? false,
    proxy: (settings.main.proxy as
      | AllSettings['network']['proxy']
      | undefined) ?? {
      enabled: false,
      hostname: '',
      port: 8080,
      useSsl: false,
      user: '',
      password: '',
      bypassFilter: '',
      bypassLocalAddresses: true,
    },
    dnsCache: {
      enabled: false,
      forceMinTtl: 0,
      forceMaxTtl: -1,
    },
    apiRequestTimeout: 10000,
  };
  delete settings.main.csrfProtection;
  delete settings.main.trustProxy;
  delete settings.main.forceIpv4First;
  delete settings.main.proxy;
  return newSettings;
};

export default migrateNetworkSettings;
