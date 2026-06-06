import type { AllSettings } from '@server/lib/settings';

const migrateGithubRepo = (settings: AllSettings): AllSettings => {
  const main = settings.main as { githubRepo?: string } | undefined;

  if (main && main.githubRepo == null) {
    main.githubRepo = 'regix1/seerr';
  }

  return settings;
};

export default migrateGithubRepo;
