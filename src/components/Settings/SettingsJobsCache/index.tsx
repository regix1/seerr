import Spinner from '@app/assets/spinner.svg';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import PageTitle from '@app/components/Common/PageTitle';
import Table from '@app/components/Common/Table';
import useLocale from '@app/hooks/useLocale';
import useSettings from '@app/hooks/useSettings';

import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import {
  buildJobScheduleOptions,
  cronToDailyTime,
  dailyTimeToCron,
  parseCronToTotalSeconds,
  totalSecondsToCron,
  withCurrentScheduleOption,
  type JobScheduleDisplayUnit,
  type JobScheduleOption,
} from '@app/utils/jobScheduleOptions';
import { formatBytes } from '@app/utils/numberHelpers';
import { Transition } from '@headlessui/react';
import { PlayIcon, StopIcon, TrashIcon } from '@heroicons/react/24/outline';
import { PencilIcon } from '@heroicons/react/24/solid';
import { MediaServerType } from '@server/constants/server';
import type {
  CacheItem,
  CacheResponse,
} from '@server/interfaces/api/settingsInterfaces';
import type { JobId } from '@server/lib/settings';
import axios from 'axios';
import cronstrue from 'cronstrue/i18n';
import humanizeDuration from 'humanize-duration';
import { Fragment, useReducer, useState } from 'react';
import type { IntlShape, MessageDescriptor } from 'react-intl';
import { FormattedRelativeTime, useIntl } from 'react-intl';
import useSWR from 'swr';

const messages: { [messageName: string]: MessageDescriptor } = defineMessages(
  'components.Settings.SettingsJobsCache',
  {
    jobsandcache: 'Jobs & Cache',
    jobs: 'Jobs',
    jobsDescription:
      'Seerr performs certain maintenance tasks as regularly-scheduled jobs, but they can also be manually triggered below. Manually running a job will not alter its schedule.',
    jobname: 'Job Name',
    jobtype: 'Type',
    nextexecution: 'Next Execution',
    runnow: 'Run Now',
    canceljob: 'Cancel Job',
    cancelJobDisabledFileFlows:
      'Scans are driven by FileFlows while "Trigger scans while processing" is enabled. Change that under FileFlows settings, or wait for the scan to finish.',
    jobstarted: '{jobname} started.',
    jobcancelled: '{jobname} canceled.',
    process: 'Process',
    command: 'Command',
    cache: 'Cache',
    cacheDescription:
      'Seerr caches requests to external API endpoints to optimize performance and avoid making unnecessary API calls.',
    cacheflushed: '{cachename} cache flushed.',
    cachename: 'Cache Name',
    cachehits: 'Hits',
    cachemisses: 'Misses',
    cachekeys: 'Total Keys',
    cacheksize: 'Key Size',
    cachevsize: 'Value Size',
    flushcache: 'Flush Cache',
    dnsCache: 'DNS Cache',
    dnsCacheDescription:
      'Seerr caches DNS lookups to optimize performance and avoid making unnecessary API calls.',
    dnscacheflushed: '{hostname} dns cache flushed.',
    dnscachename: 'Hostname',
    dnscacheactiveaddress: 'Active Address',
    dnscachehits: 'Hits',
    dnscachemisses: 'Misses',
    dnscacheage: 'Age',
    flushdnscache: 'Flush DNS Cache',
    dnsCacheGlobalStats: 'Global DNS Cache Stats',
    dnsCacheGlobalStatsDescription:
      'These stats are aggregated across all DNS cache entries.',
    dnsNoCacheEntries: 'No DNS lookups have been cached yet.',
    size: 'Size',
    hits: 'Hits',
    misses: 'Misses',
    failures: 'Failures',
    ipv4Fallbacks: 'IPv4 Fallbacks',
    hitRate: 'Hit Rate',
    unknownJob: 'Unknown Job',
    'plex-recently-added-scan': 'Plex Recently Added Scan',
    'plex-full-scan': 'Plex Full Library Scan',
    'plex-watchlist-sync': 'Plex Watchlist Sync',
    'plex-refresh-token': 'Plex Refresh Token',
    'jellyfin-full-scan': 'Jellyfin Full Library Scan',
    'jellyfin-recently-added-scan': 'Jellyfin Recently Added Scan',
    'emby-full-scan': 'Emby Full Library Scan',
    'emby-recently-added-scan': 'Emby Recently Added Scan',
    'availability-sync': 'Media Availability Sync',
    'download-completion-check': 'Download Completion Check',
    'radarr-scan': 'Radarr Scan',
    'sonarr-scan': 'Sonarr Scan',
    'fileflows-sync': 'FileFlows Sync',
    'download-sync': 'Download Sync',
    'download-sync-reset': 'Download Sync Reset',
    'image-cache-cleanup': 'Image Cache Cleanup',
    'process-blocklisted-tags': 'Process Blocklisted Tags',
    'db-backup': 'Database Backup',
    'plex-recently-added-scanDescription': 'Checks Plex for newly added media.',
    'plex-full-scanDescription':
      'Scans your entire Plex library for available media.',
    'plex-watchlist-syncDescription':
      "Imports requests from users' Plex watchlists.",
    'plex-refresh-tokenDescription':
      'Refreshes the stored Plex authentication token.',
    'jellyfin-full-scanDescription':
      'Scans your entire Jellyfin library for available media.',
    'jellyfin-recently-added-scanDescription':
      'Checks Jellyfin for newly added media.',
    'emby-full-scanDescription':
      'Scans your entire Emby library for available media.',
    'emby-recently-added-scanDescription': 'Checks Emby for newly added media.',
    'availability-syncDescription':
      "Keeps request statuses in sync with what's on your servers.",
    'download-completion-checkDescription':
      'Marks requests available once their download finishes.',
    'radarr-scanDescription':
      'Syncs movie availability and quality profiles from Radarr.',
    'sonarr-scanDescription':
      'Syncs series availability and quality profiles from Sonarr.',
    'fileflows-syncDescription':
      'Updates media processing status from FileFlows.',
    'download-syncDescription':
      'Refreshes active downloads from your download clients.',
    'download-sync-resetDescription':
      'Clears and rebuilds the active download list.',
    'image-cache-cleanupDescription':
      'Removes expired images from the local cache.',
    'process-blocklisted-tagsDescription':
      'Removes media matching your blocklisted tags.',
    'db-backupDescription': 'Creates a scheduled backup of the database.',
    editJobSchedule: 'Modify Job',
    jobScheduleEditSaved: 'Job edited successfully!',
    jobScheduleEditFailed: 'Something went wrong while saving the job.',
    editJobScheduleCurrent: 'Current Frequency',
    editJobSchedulePrompt: 'New Frequency',
    editJobScheduleSelectorDays:
      'Every {jobScheduleDays, plural, one {day} other {{jobScheduleDays} days}}',
    editJobScheduleSelectorHours:
      'Every {jobScheduleHours, plural, one {hour} other {{jobScheduleHours} hours}}',
    editJobScheduleSelectorMinutes:
      'Every {jobScheduleMinutes, plural, one {minute} other {{jobScheduleMinutes} minutes}}',
    editJobScheduleSelectorSeconds:
      'Every {jobScheduleSeconds, plural, one {second} other {{jobScheduleSeconds} seconds}}',
    errorRunningJob: 'Failed to run job.',
    errorCancellingJob: 'Failed to cancel job.',
    errorFlushingCache: 'Failed to flush cache.',
    errorFlushingDnsCache: 'Failed to flush DNS cache.',
    imagecache: 'Image Cache',
    imagecacheDescription:
      'When enabled in settings, Seerr will proxy and cache images from pre-configured external sources. Cached images are saved into your config folder. You can find the files in <code>{appDataPath}/cache/images</code>.',
    imagecachecount: 'Images Cached',
    imagecachesize: 'Total Cache Size',
    usersavatars: "Users' Avatars",
  }
);

interface Job {
  id: JobId;
  name: string;
  type: 'process' | 'command';
  interval: 'seconds' | 'minutes' | 'hours' | 'days' | 'fixed';
  cronSchedule: string;
  nextExecutionTime: string;
  running: boolean;
}

type JobModalState = {
  isOpen?: boolean;
  job?: Job;
  scheduleTotalSeconds: number;
  scheduleTime: string;
};

type JobModalAction =
  | {
      type: 'set';
      scheduleTotalSeconds: number;
    }
  | {
      type: 'setTime';
      scheduleTime: string;
    }
  | {
      type: 'close';
    }
  | { type: 'open'; job?: Job };

const DEFAULT_SCHEDULE_TOTAL_SECONDS = 300;

const isArrScanJob = (jobId?: JobId): boolean =>
  jobId === 'radarr-scan' || jobId === 'sonarr-scan';

// Jobs that run once a day at a user-chosen time use a time-of-day picker
// instead of the frequency-interval selector (matching the Backup settings tab).
const isDailyTimeJob = (jobId?: JobId): boolean => jobId === 'db-backup';

const formatScheduleOptionLabel = (
  intl: IntlShape,
  option: JobScheduleOption
): string => {
  const messageByUnit: Record<
    JobScheduleDisplayUnit,
    (value: number) => string
  > = {
    seconds: (value) =>
      intl.formatMessage(messages.editJobScheduleSelectorSeconds, {
        jobScheduleSeconds: value,
      }),
    minutes: (value) =>
      intl.formatMessage(messages.editJobScheduleSelectorMinutes, {
        jobScheduleMinutes: value,
      }),
    hours: (value) =>
      intl.formatMessage(messages.editJobScheduleSelectorHours, {
        jobScheduleHours: value,
      }),
    days: (value) =>
      intl.formatMessage(messages.editJobScheduleSelectorDays, {
        jobScheduleDays: value,
      }),
  };

  return messageByUnit[option.displayUnit](option.displayValue);
};

const jobModalReducer = (
  state: JobModalState,
  action: JobModalAction
): JobModalState => {
  switch (action.type) {
    case 'close':
      return {
        ...state,
        isOpen: false,
      };

    case 'open': {
      const scheduleTotalSeconds = action.job
        ? parseCronToTotalSeconds(action.job.cronSchedule, action.job.interval)
        : DEFAULT_SCHEDULE_TOTAL_SECONDS;

      return {
        isOpen: true,
        job: action.job,
        scheduleTotalSeconds,
        scheduleTime: cronToDailyTime(action.job?.cronSchedule),
      };
    }

    case 'set':
      return {
        ...state,
        scheduleTotalSeconds: action.scheduleTotalSeconds,
      };

    case 'setTime':
      return {
        ...state,
        scheduleTime: action.scheduleTime,
      };
  }
};

const SettingsJobs = () => {
  const intl = useIntl();
  const { locale } = useLocale();
  const { addToast } = useToasts();
  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<Job[]>('/api/v1/settings/jobs', {
    refreshInterval: 5000,
  });
  const { data: appData } = useSWR('/api/v1/status/appdata');
  const { data: cacheData, mutate: cacheRevalidate } = useSWR<CacheResponse>(
    '/api/v1/settings/cache',
    {
      refreshInterval: 10000,
    }
  );
  const { data: fileFlowsSettings } = useSWR<{
    enabled: boolean;
    availabilitySync: 'schedule' | 'active';
  }>('/api/v1/settings/fileflows');

  const fileFlowsTriggersArrScans = Boolean(
    fileFlowsSettings?.enabled &&
    fileFlowsSettings?.availabilitySync === 'active'
  );

  const isArrScanCancelDisabled = (job: Job): boolean =>
    fileFlowsTriggersArrScans && isArrScanJob(job.id);

  const [jobModalState, dispatch] = useReducer(jobModalReducer, {
    isOpen: false,
    scheduleTotalSeconds: DEFAULT_SCHEDULE_TOTAL_SECONDS,
    scheduleTime: cronToDailyTime(undefined),
  });
  const [isSaving, setIsSaving] = useState(false);
  const settings = useSettings();

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  const runJob = async (job: Job) => {
    try {
      await axios.post(`/api/v1/settings/jobs/${job.id}/run`);
      addToast(
        intl.formatMessage(messages.jobstarted, {
          jobname: intl.formatMessage(messages[job.id] ?? messages.unknownJob),
        }),
        {
          appearance: 'success',
          autoDismiss: true,
        }
      );
    } catch {
      addToast(intl.formatMessage(messages.errorRunningJob), {
        appearance: 'error',
        autoDismiss: true,
      });
    }
    revalidate();
  };

  const cancelJob = async (job: Job) => {
    try {
      await axios.post(`/api/v1/settings/jobs/${job.id}/cancel`);
      addToast(
        intl.formatMessage(messages.jobcancelled, {
          jobname: intl.formatMessage(messages[job.id] ?? messages.unknownJob),
        }),
        {
          appearance: 'error',
          autoDismiss: true,
        }
      );
    } catch {
      addToast(intl.formatMessage(messages.errorCancellingJob), {
        appearance: 'error',
        autoDismiss: true,
      });
    }
    revalidate();
  };

  const flushCache = async (cache: CacheItem) => {
    try {
      await axios.post(`/api/v1/settings/cache/${cache.id}/flush`);
      addToast(
        intl.formatMessage(messages.cacheflushed, { cachename: cache.name }),
        {
          appearance: 'success',
          autoDismiss: true,
        }
      );
    } catch {
      addToast(intl.formatMessage(messages.errorFlushingCache), {
        appearance: 'error',
        autoDismiss: true,
      });
    }
    cacheRevalidate();
  };

  const flushDnsCache = async (hostname: string) => {
    try {
      await axios.post(`/api/v1/settings/cache/dns/${hostname}/flush`);
      addToast(
        intl.formatMessage(messages.dnscacheflushed, { hostname: hostname }),
        {
          appearance: 'success',
          autoDismiss: true,
        }
      );
    } catch {
      addToast(intl.formatMessage(messages.errorFlushingDnsCache), {
        appearance: 'error',
        autoDismiss: true,
      });
    }
    cacheRevalidate();
  };

  const scheduleJob = async () => {
    try {
      const job = jobModalState.job;
      if (!job) {
        throw new Error();
      }

      let schedule: string;
      if (isDailyTimeJob(job.id)) {
        schedule = dailyTimeToCron(jobModalState.scheduleTime);
      } else {
        if (job.interval === 'fixed') {
          throw new Error();
        }
        schedule = totalSecondsToCron(
          jobModalState.scheduleTotalSeconds,
          job.interval
        );
      }

      setIsSaving(true);
      await axios.post(`/api/v1/settings/jobs/${job.id}/schedule`, {
        schedule,
      });

      addToast(intl.formatMessage(messages.jobScheduleEditSaved), {
        appearance: 'success',
        autoDismiss: true,
      });

      dispatch({ type: 'close' });
      revalidate();
    } catch {
      addToast(intl.formatMessage(messages.jobScheduleEditFailed), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsSaving(false);
    }
  };

  const formatAge = (milliseconds: number): string => {
    return humanizeDuration(milliseconds, {
      units: ['m', 's'],
      round: true,
      language: locale,
    });
  };

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.jobsandcache),
          intl.formatMessage(globalMessages.settings),
        ]}
      />
      <Transition
        as={Fragment}
        enter="transition-opacity duration-300"
        enterFrom="opacity-0"
        enterTo="opacity-100"
        leave="transition-opacity duration-300"
        leaveFrom="opacity-100"
        leaveTo="opacity-0"
        show={jobModalState.isOpen}
      >
        <Modal
          title={intl.formatMessage(messages.editJobSchedule)}
          okText={
            isSaving
              ? intl.formatMessage(globalMessages.saving)
              : intl.formatMessage(globalMessages.save)
          }
          onCancel={() => dispatch({ type: 'close' })}
          okDisabled={isSaving}
          onOk={() => scheduleJob()}
        >
          <div className="section">
            <form className="mb-6">
              <div className="form-row">
                <label className="text-label">
                  {intl.formatMessage(messages.editJobScheduleCurrent)}
                </label>
                <div className="form-input-area mb-1 mt-2">
                  <div>
                    {jobModalState.job &&
                      cronstrue.toString(jobModalState.job.cronSchedule, {
                        locale,
                      })}
                  </div>
                  <div className="text-sm text-gray-500">
                    {jobModalState.job?.cronSchedule}
                  </div>
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="jobSchedule" className="text-label">
                  {intl.formatMessage(messages.editJobSchedulePrompt)}
                </label>
                <div className="form-input-area">
                  {jobModalState.job &&
                    isDailyTimeJob(jobModalState.job.id) && (
                      <div className="form-input-field">
                        <input
                          type="time"
                          name="jobSchedule"
                          className="block"
                          value={jobModalState.scheduleTime}
                          onChange={(e) =>
                            dispatch({
                              type: 'setTime',
                              scheduleTime: e.target.value,
                            })
                          }
                        />
                      </div>
                    )}
                  {jobModalState.job &&
                    !isDailyTimeJob(jobModalState.job.id) &&
                    jobModalState.job.interval !== 'fixed' && (
                      <select
                        name="jobSchedule"
                        className="inline"
                        value={jobModalState.scheduleTotalSeconds}
                        onChange={(e) =>
                          dispatch({
                            type: 'set',
                            scheduleTotalSeconds: Number(e.target.value),
                          })
                        }
                      >
                        {withCurrentScheduleOption(
                          buildJobScheduleOptions(jobModalState.job.interval),
                          jobModalState.scheduleTotalSeconds
                        ).map((option) => (
                          <option
                            value={option.totalSeconds}
                            key={`jobSchedule-${option.totalSeconds}`}
                          >
                            {formatScheduleOptionLabel(intl, option)}
                          </option>
                        ))}
                      </select>
                    )}
                </div>
              </div>
            </form>
          </div>
        </Modal>
      </Transition>

      <div className="mb-6">
        <h3 className="heading">{intl.formatMessage(messages.jobs)}</h3>
        <p className="description">
          {intl.formatMessage(messages.jobsDescription)}
        </p>
      </div>
      <div className="section">
        <Table>
          <thead>
            <tr>
              <Table.TH>{intl.formatMessage(messages.jobname)}</Table.TH>
              <Table.TH>{intl.formatMessage(messages.jobtype)}</Table.TH>
              <Table.TH>{intl.formatMessage(messages.nextexecution)}</Table.TH>
              <Table.TH />
            </tr>
          </thead>
          <Table.TBody>
            {data?.map((job) => (
              <tr key={`job-list-${job.id}`}>
                <Table.TD>
                  <div className="flex items-center text-sm leading-5 text-white">
                    <span>
                      {intl.formatMessage(
                        messages[job.id] ?? messages.unknownJob
                      )}
                    </span>
                    {job.running && <Spinner className="ml-2 h-5 w-5" />}
                  </div>
                  {messages[`${job.id}Description`] && (
                    <div className="mt-1 text-xs leading-4 text-gray-400">
                      {intl.formatMessage(messages[`${job.id}Description`])}
                    </div>
                  )}
                </Table.TD>
                <Table.TD>
                  <Badge
                    badgeType={job.type === 'process' ? 'primary' : 'warning'}
                    className="uppercase"
                  >
                    {job.type === 'process'
                      ? intl.formatMessage(messages.process)
                      : intl.formatMessage(messages.command)}
                  </Badge>
                </Table.TD>
                <Table.TD>
                  <div className="text-sm leading-5 text-white">
                    <FormattedRelativeTime
                      value={Math.floor(
                        (new Date(job.nextExecutionTime).getTime() -
                          Date.now()) /
                          1000
                      )}
                      updateIntervalInSeconds={1}
                      numeric="auto"
                    />
                  </div>
                </Table.TD>
                <Table.TD alignText="right">
                  {job.interval !== 'fixed' && (
                    <Button
                      className="mr-2"
                      buttonType="warning"
                      onClick={() => dispatch({ type: 'open', job })}
                    >
                      <PencilIcon />
                      <span>{intl.formatMessage(globalMessages.edit)}</span>
                    </Button>
                  )}
                  {job.running ? (
                    isArrScanCancelDisabled(job) ? (
                      <Button
                        buttonType="default"
                        disabled
                        title={intl.formatMessage(
                          messages.cancelJobDisabledFileFlows
                        )}
                      >
                        <StopIcon />
                        <span>{intl.formatMessage(messages.canceljob)}</span>
                      </Button>
                    ) : (
                      <Button
                        buttonType="danger"
                        onClick={() => cancelJob(job)}
                      >
                        <StopIcon />
                        <span>{intl.formatMessage(messages.canceljob)}</span>
                      </Button>
                    )
                  ) : (
                    <Button buttonType="primary" onClick={() => runJob(job)}>
                      <PlayIcon />
                      <span>{intl.formatMessage(messages.runnow)}</span>
                    </Button>
                  )}
                </Table.TD>
              </tr>
            ))}
          </Table.TBody>
        </Table>
      </div>
      <div>
        <h3 className="heading">{intl.formatMessage(messages.cache)}</h3>
        <p className="description">
          {intl.formatMessage(messages.cacheDescription)}
        </p>
      </div>
      <div className="section">
        <Table>
          <thead>
            <tr>
              <Table.TH>{intl.formatMessage(messages.cachename)}</Table.TH>
              <Table.TH>{intl.formatMessage(messages.cachehits)}</Table.TH>
              <Table.TH>{intl.formatMessage(messages.cachemisses)}</Table.TH>
              <Table.TH>{intl.formatMessage(messages.cachekeys)}</Table.TH>
              <Table.TH>{intl.formatMessage(messages.cacheksize)}</Table.TH>
              <Table.TH>{intl.formatMessage(messages.cachevsize)}</Table.TH>
              <Table.TH />
            </tr>
          </thead>
          <Table.TBody>
            {cacheData?.apiCaches
              ?.filter(
                (cache) =>
                  cache.id !== 'plexguid' ||
                  settings.currentSettings.plexLoginEnabled ||
                  settings.currentSettings.mediaServerType ===
                    MediaServerType.PLEX
              )
              .map((cache) => (
                <tr key={`cache-list-${cache.id}`}>
                  <Table.TD>{cache.name}</Table.TD>
                  <Table.TD>{intl.formatNumber(cache.stats.hits)}</Table.TD>
                  <Table.TD>{intl.formatNumber(cache.stats.misses)}</Table.TD>
                  <Table.TD>{intl.formatNumber(cache.stats.keys)}</Table.TD>
                  <Table.TD>{formatBytes(cache.stats.ksize)}</Table.TD>
                  <Table.TD>{formatBytes(cache.stats.vsize)}</Table.TD>
                  <Table.TD alignText="right">
                    <Button
                      buttonType="danger"
                      onClick={() => flushCache(cache)}
                    >
                      <TrashIcon />
                      <span>{intl.formatMessage(messages.flushcache)}</span>
                    </Button>
                  </Table.TD>
                </tr>
              ))}
          </Table.TBody>
        </Table>
      </div>
      {cacheData?.dnsCache != null && (
        <>
          <div>
            <h3 className="heading">{intl.formatMessage(messages.dnsCache)}</h3>
            <p className="description">
              {intl.formatMessage(messages.dnsCacheDescription)}
            </p>
          </div>
          <div className="section">
            <Table>
              <thead>
                <tr>
                  <Table.TH>
                    {intl.formatMessage(messages.dnscachename)}
                  </Table.TH>
                  <Table.TH>
                    {intl.formatMessage(messages.dnscacheactiveaddress)}
                  </Table.TH>
                  <Table.TH>
                    {intl.formatMessage(messages.dnscachehits)}
                  </Table.TH>
                  <Table.TH>
                    {intl.formatMessage(messages.dnscachemisses)}
                  </Table.TH>
                  <Table.TH>
                    {intl.formatMessage(messages.dnscacheage)}
                  </Table.TH>
                  <Table.TH />
                </tr>
              </thead>
              <Table.TBody>
                {(() => {
                  if (!cacheData) {
                    return (
                      <tr>
                        <Table.TD colSpan={6} alignText="center">
                          <LoadingSpinner />
                        </Table.TD>
                      </tr>
                    );
                  }

                  const entries = Object.entries(
                    cacheData.dnsCache?.entries ?? {}
                  );

                  if (entries.length === 0) {
                    return (
                      <tr>
                        <Table.TD colSpan={6} alignText="center">
                          {intl.formatMessage(messages.dnsNoCacheEntries)}
                        </Table.TD>
                      </tr>
                    );
                  }

                  return entries.map(([hostname, data]) => (
                    <tr key={`cache-list-${hostname}`}>
                      <Table.TD>{hostname}</Table.TD>
                      <Table.TD>{data.activeAddress}</Table.TD>
                      <Table.TD>{intl.formatNumber(data.hits)}</Table.TD>
                      <Table.TD>{intl.formatNumber(data.misses)}</Table.TD>
                      <Table.TD>{formatAge(data.age)}</Table.TD>
                      <Table.TD alignText="right">
                        <Button
                          buttonType="danger"
                          onClick={() => flushDnsCache(hostname)}
                        >
                          <TrashIcon />
                          <span>
                            {intl.formatMessage(messages.flushdnscache)}
                          </span>
                        </Button>
                      </Table.TD>
                    </tr>
                  ));
                })()}
              </Table.TBody>
            </Table>
          </div>
          <div>
            <h3 className="heading">
              {intl.formatMessage(messages.dnsCacheGlobalStats)}
            </h3>
            <p className="description">
              {intl.formatMessage(messages.dnsCacheGlobalStatsDescription)}
            </p>
          </div>
          <div className="section">
            {!cacheData ? (
              <LoadingSpinner />
            ) : (
              <Table>
                <thead>
                  <tr>
                    {Object.entries(cacheData.dnsCache?.stats ?? {})
                      .filter(([statName]) => statName !== 'maxSize')
                      .map(([statName]) => (
                        <Table.TH key={`dns-stat-header-${statName}`}>
                          {messages[statName]
                            ? intl.formatMessage(messages[statName])
                            : statName}
                        </Table.TH>
                      ))}
                  </tr>
                </thead>
                <Table.TBody>
                  <tr>
                    {Object.entries(cacheData.dnsCache?.stats ?? {})
                      .filter(([statName]) => statName !== 'maxSize')
                      .map(([statName, statValue]) => (
                        <Table.TD key={`dns-stat-${statName}`}>
                          {statName === 'hitRate'
                            ? intl.formatNumber(statValue, {
                                style: 'percent',
                                maximumFractionDigits: 2,
                              })
                            : intl.formatNumber(statValue)}
                        </Table.TD>
                      ))}
                  </tr>
                </Table.TBody>
              </Table>
            )}
          </div>
        </>
      )}
      <div className="break-words">
        <h3 className="heading">{intl.formatMessage(messages.imagecache)}</h3>
        <p className="description">
          {intl.formatMessage(messages.imagecacheDescription, {
            code: (msg: React.ReactNode) => (
              <code key="code-block" className="bg-gray-800/50">
                {msg}
              </code>
            ),
            appDataPath: appData ? appData.appDataPath : '/app/config',
          })}
        </p>
      </div>
      <div className="section">
        <Table>
          <thead>
            <tr>
              <Table.TH>{intl.formatMessage(messages.cachename)}</Table.TH>
              <Table.TH>
                {intl.formatMessage(messages.imagecachecount)}
              </Table.TH>
              <Table.TH>{intl.formatMessage(messages.imagecachesize)}</Table.TH>
            </tr>
          </thead>
          <Table.TBody>
            <tr>
              <Table.TD>The Movie Database (tmdb)</Table.TD>
              <Table.TD>
                {intl.formatNumber(cacheData?.imageCache.tmdb.imageCount ?? 0)}
              </Table.TD>
              <Table.TD>
                {formatBytes(cacheData?.imageCache.tmdb.size ?? 0)}
              </Table.TD>
            </tr>
            <tr>
              <Table.TD>
                {intl.formatMessage(messages.usersavatars)} (avatar)
              </Table.TD>
              <Table.TD>
                {intl.formatNumber(
                  cacheData?.imageCache.avatar.imageCount ?? 0
                )}
              </Table.TD>
              <Table.TD>
                {formatBytes(cacheData?.imageCache.avatar.size ?? 0)}
              </Table.TD>
            </tr>
          </Table.TBody>
        </Table>
      </div>
    </>
  );
};

export default SettingsJobs;
