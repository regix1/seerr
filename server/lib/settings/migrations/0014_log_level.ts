import type { AllSettings } from '@server/lib/settings';

const migrateLogLevel = (settings: AllSettings): AllSettings => {
  const network = settings.network as { logLevel?: string } | undefined;

  if (network && network.logLevel == null) {
    network.logLevel = 'debug';
  }

  return settings;
};

export default migrateLogLevel;
