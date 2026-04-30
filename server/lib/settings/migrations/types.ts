import type { AllSettings } from '@server/lib/settings';

export type LegacySettings = AllSettings & {
  main: AllSettings['main'] & { region?: string };
  jellyfin: AllSettings['jellyfin'] & { hostname?: string };
};
