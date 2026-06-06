import { getSettings } from '@server/lib/settings';

export const GITHUB_DEVELOP_BRANCH = 'develop';
const DEFAULT_REPO_SLUG = 'regix1/seerr';

export const parseGithubRepoSlug = (value?: string): string | null => {
  const trimmed = value?.trim();

  if (!trimmed || !/^[\w.-]+\/[\w.-]+$/.test(trimmed)) {
    return null;
  }

  return trimmed;
};

export const resolveGithubRepoSlug = (configured?: string): string =>
  parseGithubRepoSlug(configured) ??
  parseGithubRepoSlug(process.env.GITHUB_REPO) ??
  DEFAULT_REPO_SLUG;

export const getGithubRepoSlug = (): string =>
  resolveGithubRepoSlug(getSettings().main.githubRepo);

export const getGithubRepoUrl = (repoSlug = getGithubRepoSlug()): string =>
  `https://github.com/${repoSlug}`;

export const getGithubApiRepoUrl = (repoSlug = getGithubRepoSlug()): string =>
  `https://api.github.com/repos/${repoSlug}`;
