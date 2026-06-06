import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import List from '@app/components/Common/List';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import Releases from '@app/components/Settings/SettingsAbout/Releases';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import type {
  SettingsAboutResponse,
  StatusResponse,
} from '@server/interfaces/api/settingsInterfaces';
import axios from 'axios';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Settings.SettingsAbout', {
  about: 'About',
  aboutseerr: 'About Seerr',
  version: 'Version',
  totalmedia: 'Total Media',
  totalrequests: 'Total Requests',
  gettingsupport: 'Getting Support',
  githubdiscussions: 'GitHub Discussions',
  githubRepo: 'GitHub Repository',
  githubRepoTip:
    'Repository used for version checks, release notes, and update links. Use owner/repo format (e.g. regix1/seerr).',
  saveGithubRepo: 'Save Repository',
  toastGithubRepoSuccess: 'GitHub repository updated.',
  toastGithubRepoFailure: 'Failed to update GitHub repository.',
  validationGithubRepo: 'Enter a valid repository in owner/repo format.',
  timezone: 'Time Zone',
  appDataPath: 'Data Directory',
  supportseerr: 'Support Seerr',
  contribute: 'Make a Contribution',
  documentation: 'Documentation',
  outofdate: 'Out of Date',
  uptodate: 'Up to Date',
  runningDevelop:
    'You are running the <code>develop</code> branch of Seerr, which is only recommended for those contributing to development or assisting with bleeding-edge testing.',
});

const GITHUB_REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

const SettingsAbout = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { data, error, mutate } = useSWR<SettingsAboutResponse>(
    '/api/v1/settings/about'
  );
  const { data: status, mutate: mutateStatus } =
    useSWR<StatusResponse>('/api/v1/status');
  const [githubRepo, setGithubRepo] = useState('');

  useEffect(() => {
    if (data?.githubRepo) {
      setGithubRepo(data.githubRepo);
    }
  }, [data?.githubRepo]);

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  if (!data) {
    return <ErrorPage statusCode={500} />;
  }

  const saveGithubRepo = async () => {
    if (!GITHUB_REPO_PATTERN.test(githubRepo.trim())) {
      addToast(intl.formatMessage(messages.validationGithubRepo), {
        appearance: 'error',
        autoDismiss: true,
      });
      return;
    }

    try {
      await axios.post('/api/v1/settings/main', {
        githubRepo: githubRepo.trim(),
      });
      await mutate();
      await mutateStatus();
      addToast(intl.formatMessage(messages.toastGithubRepoSuccess), {
        appearance: 'success',
        autoDismiss: true,
      });
    } catch {
      addToast(intl.formatMessage(messages.toastGithubRepoFailure), {
        appearance: 'error',
        autoDismiss: true,
      });
    }
  };

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.about),
          intl.formatMessage(globalMessages.settings),
        ]}
      />
      <div className="section">
        <List title={intl.formatMessage(messages.aboutseerr)}>
          {data.version.startsWith('develop-') && (
            <Alert
              title={intl.formatMessage(messages.runningDevelop, {
                code: (msg: React.ReactNode) => (
                  <code className="bg-gray-800/50">{msg}</code>
                ),
              })}
            />
          )}
          <List.Item title={intl.formatMessage(messages.githubRepo)}>
            <div className="flex w-full max-w-xl flex-col gap-2 sm:flex-row">
              <input
                type="text"
                className="flex-grow"
                value={githubRepo}
                onChange={(e) => setGithubRepo(e.target.value)}
                placeholder="owner/repo"
              />
              <Button
                buttonType="primary"
                onClick={() => saveGithubRepo()}
                disabled={githubRepo.trim() === data.githubRepo}
              >
                <span>{intl.formatMessage(messages.saveGithubRepo)}</span>
              </Button>
            </div>
            <p className="mt-2 text-sm text-gray-400">
              {intl.formatMessage(messages.githubRepoTip)}
            </p>
          </List.Item>
          <List.Item
            title={intl.formatMessage(messages.version)}
            className="flex flex-row items-center truncate"
          >
            <code className="truncate">
              {data.version.replace('develop-', '')}
            </code>
            {status?.commitTag !== 'local' &&
              (status?.updateAvailable ? (
                <a
                  href={
                    data.version.startsWith('develop-')
                      ? `${data.githubRepoUrl}/compare/${status.commitTag}...${data.githubDevelopBranch}`
                      : `${data.githubRepoUrl}/releases`
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Badge
                    badgeType="warning"
                    className="ml-2 !cursor-pointer transition hover:bg-yellow-400"
                  >
                    {intl.formatMessage(messages.outofdate)}
                  </Badge>
                </a>
              ) : (
                <a
                  href={
                    data.version.startsWith('develop-')
                      ? `${data.githubRepoUrl}/commits/${data.githubDevelopBranch}`
                      : `${data.githubRepoUrl}/releases`
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Badge
                    badgeType="success"
                    className="ml-2 !cursor-pointer transition hover:bg-green-400"
                  >
                    {intl.formatMessage(messages.uptodate)}
                  </Badge>
                </a>
              ))}
          </List.Item>
          <List.Item title={intl.formatMessage(messages.totalmedia)}>
            {intl.formatNumber(data.totalMediaItems)}
          </List.Item>
          <List.Item title={intl.formatMessage(messages.totalrequests)}>
            {intl.formatNumber(data.totalRequests)}
          </List.Item>
          <List.Item title={intl.formatMessage(messages.appDataPath)}>
            <code>{data.appDataPath}</code>
          </List.Item>
          {data.tz && (
            <List.Item title={intl.formatMessage(messages.timezone)}>
              <code>{data.tz}</code>
            </List.Item>
          )}
        </List>
      </div>
      <div className="section">
        <List title={intl.formatMessage(messages.gettingsupport)}>
          <List.Item title={intl.formatMessage(messages.documentation)}>
            <a
              href="https://docs.seerr.dev"
              target="_blank"
              rel="noreferrer"
              className="text-indigo-500 transition duration-300 hover:underline"
            >
              https://docs.seerr.dev
            </a>
          </List.Item>
          <List.Item title={intl.formatMessage(messages.githubdiscussions)}>
            <a
              href={`${data.githubRepoUrl}/discussions`}
              target="_blank"
              rel="noreferrer"
              className="text-indigo-500 transition duration-300 hover:underline"
            >
              {`${data.githubRepoUrl}/discussions`}
            </a>
          </List.Item>
          <List.Item title="Discord">
            <a
              href="https://discord.gg/seerr"
              target="_blank"
              rel="noreferrer"
              className="text-indigo-500 transition duration-300 hover:underline"
            >
              https://discord.gg/seerr
            </a>
          </List.Item>
        </List>
      </div>
      <div className="section">
        <List title={intl.formatMessage(messages.supportseerr)}>
          <List.Item title={intl.formatMessage(messages.contribute)}>
            <a
              href="https://opencollective.com/seerr"
              target="_blank"
              rel="noreferrer"
              className="text-indigo-500 transition duration-300 hover:underline"
            >
              https://opencollective.com/seerr
            </a>
          </List.Item>
        </List>
      </div>
      <div className="section">
        <Releases
          currentVersion={data.version}
          releasesApiUrl={data.githubReleasesUrl}
        />
      </div>
    </>
  );
};

export default SettingsAbout;
