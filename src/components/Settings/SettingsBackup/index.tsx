import Spinner from '@app/assets/spinner.svg';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import PageTitle from '@app/components/Common/PageTitle';
import Table from '@app/components/Common/Table';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import {
  buildJobScheduleOptions,
  parseCronToTotalSeconds,
  totalSecondsToCron,
  withCurrentScheduleOption,
  type JobScheduleDisplayUnit,
  type JobScheduleOption,
} from '@app/utils/jobScheduleOptions';
import { formatBytes } from '@app/utils/numberHelpers';
import { Transition } from '@headlessui/react';
import {
  ArrowDownTrayIcon,
  PlayIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import { PencilIcon } from '@heroicons/react/24/solid';
import axios from 'axios';
import cronstrue from 'cronstrue/i18n';
import { Field, Form, Formik } from 'formik';
import { Fragment, useReducer, useState } from 'react';
import type { IntlShape, MessageDescriptor } from 'react-intl';
import { useIntl } from 'react-intl';
import useSWR from 'swr';
import * as Yup from 'yup';

const messages: { [messageName: string]: MessageDescriptor } = defineMessages(
  'components.Settings.SettingsBackup',
  {
    backup: 'Backup',
    backupDescription:
      'Schedule and manage backups of your database and settings. Backups are stored on the Docker host in the config directory.',
    configSection: 'Backup Configuration',
    configSectionDescription:
      'Configure automatic backup settings. The database backup job runs on the schedule below.',
    enabledLabel: 'Enable Automatic Backups',
    enabledTip: 'Automatically create backups on the configured schedule.',
    retentionLabel: 'Retention',
    retentionTip:
      'Number of recent backups to keep. Older backups are deleted automatically.',
    scheduleLabel: 'Schedule',
    scheduleTip: 'How often to run the automatic backup job.',
    saveSettings: 'Save Changes',
    saving: 'Saving…',
    settingsSaved: 'Backup settings saved successfully.',
    settingsFailed: 'Failed to save backup settings.',
    backupNow: 'Backup Now',
    backupStarted: 'Backup created successfully.',
    backupFailed: 'Failed to create backup.',
    backupRunning: 'A backup is already running.',
    backupsSection: 'Backups',
    backupsSectionDescription:
      'Existing backups, newest first. Download a backup to restore manually.',
    colCreatedAt: 'Created',
    colDbSize: 'DB Size',
    colSettingsSize: 'Settings Size',
    colActions: 'Actions',
    downloadDb: 'Download DB',
    downloadSettings: 'Download Settings',
    deleteBackup: 'Delete',
    deleteConfirmTitle: 'Delete Backup',
    deleteConfirmBody:
      'Are you sure you want to delete this backup? This cannot be undone.',
    deleteConfirmOk: 'Delete',
    deleteSuccess: 'Backup deleted.',
    deleteFailed: 'Failed to delete backup.',
    noBackups:
      'No backups yet. Click “Backup Now” to create your first backup.',
    backupDirLabel: 'Backup Directory',
    restoreNote:
      'To restore: stop the container, replace <code>db/db.sqlite3</code> in your config directory with a downloaded DB backup, then restart.',
    editSchedule: 'Edit Schedule',
    scheduleEditSaved: 'Schedule updated successfully.',
    scheduleEditFailed: 'Failed to update schedule.',
    currentFrequency: 'Current Frequency',
    newFrequency: 'New Frequency',
    editJobScheduleSelectorDays:
      'Every {jobScheduleDays, plural, one {day} other {{jobScheduleDays} days}}',
    editJobScheduleSelectorHours:
      'Every {jobScheduleHours, plural, one {hour} other {{jobScheduleHours} hours}}',
    editJobScheduleSelectorMinutes:
      'Every {jobScheduleMinutes, plural, one {minute} other {{jobScheduleMinutes} minutes}}',
    editJobScheduleSelectorSeconds:
      'Every {jobScheduleSeconds, plural, one {second} other {{jobScheduleSeconds} seconds}}',
    validationRetention: 'Retention must be a positive number.',
  }
);

export interface BackupInfo {
  id: string;
  createdAt: string;
  dbSize: number;
  settingsSize: number;
}

interface BackupSettingsResponse {
  enabled: boolean;
  retention: number;
  backupDir: string;
  backups: BackupInfo[];
}

interface ScheduleJob {
  id: string;
  interval: 'seconds' | 'minutes' | 'hours' | 'days' | 'fixed';
  cronSchedule: string;
}

type ScheduleModalState = {
  isOpen: boolean;
  scheduleTotalSeconds: number;
  job?: ScheduleJob;
};

type ScheduleModalAction =
  | { type: 'open'; job: ScheduleJob }
  | { type: 'close' }
  | { type: 'set'; scheduleTotalSeconds: number };

const DEFAULT_SCHEDULE_TOTAL_SECONDS = 14400; // 4 hours

const scheduleModalReducer = (
  state: ScheduleModalState,
  action: ScheduleModalAction
): ScheduleModalState => {
  switch (action.type) {
    case 'open': {
      const scheduleTotalSeconds = parseCronToTotalSeconds(
        action.job.cronSchedule,
        action.job.interval
      );
      return { isOpen: true, job: action.job, scheduleTotalSeconds };
    }
    case 'close':
      return { ...state, isOpen: false };
    case 'set':
      return { ...state, scheduleTotalSeconds: action.scheduleTotalSeconds };
  }
};

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

interface DeleteConfirmState {
  isOpen: boolean;
  backupId: string | null;
}

const BackupValidationSchema = Yup.object().shape({
  retention: Yup.number()
    .integer()
    .min(1, 'Retention must be at least 1.')
    .required('Retention is required.'),
});

const SettingsBackup = () => {
  const intl = useIntl();
  const { addToast } = useToasts();

  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<BackupSettingsResponse>('/api/v1/settings/backup', {
    refreshInterval: 10000,
  });

  const { data: jobData } = useSWR<ScheduleJob[]>('/api/v1/settings/jobs', {
    refreshInterval: 10000,
  });

  const dbBackupJob = jobData?.find((j) => j.id === 'db-backup');

  const [isBackingUp, setIsBackingUp] = useState(false);
  const [scheduleModal, dispatchSchedule] = useReducer(scheduleModalReducer, {
    isOpen: false,
    scheduleTotalSeconds: DEFAULT_SCHEDULE_TOTAL_SECONDS,
  });
  const [isSavingSchedule, setIsSavingSchedule] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState>({
    isOpen: false,
    backupId: null,
  });
  const [isDeleting, setIsDeleting] = useState(false);

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  const handleBackupNow = async () => {
    setIsBackingUp(true);
    try {
      await axios.post('/api/v1/settings/backup/run');
      addToast(intl.formatMessage(messages.backupStarted), {
        appearance: 'success',
        autoDismiss: true,
      });
      revalidate();
    } catch (err: unknown) {
      const status =
        err &&
        typeof err === 'object' &&
        'response' in err &&
        err.response &&
        typeof err.response === 'object' &&
        'status' in err.response
          ? (err.response as { status: number }).status
          : 0;
      if (status === 409) {
        addToast(intl.formatMessage(messages.backupRunning), {
          appearance: 'warning',
          autoDismiss: true,
        });
      } else {
        addToast(intl.formatMessage(messages.backupFailed), {
          appearance: 'error',
          autoDismiss: true,
        });
      }
    } finally {
      setIsBackingUp(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteConfirm.backupId) return;
    setIsDeleting(true);
    try {
      await axios.delete(`/api/v1/settings/backup/${deleteConfirm.backupId}`);
      addToast(intl.formatMessage(messages.deleteSuccess), {
        appearance: 'success',
        autoDismiss: true,
      });
      setDeleteConfirm({ isOpen: false, backupId: null });
      revalidate();
    } catch {
      addToast(intl.formatMessage(messages.deleteFailed), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsDeleting(false);
    }
  };

  const handleScheduleSave = async () => {
    if (!scheduleModal.job || scheduleModal.job.interval === 'fixed') return;
    setIsSavingSchedule(true);
    try {
      const schedule = totalSecondsToCron(
        scheduleModal.scheduleTotalSeconds,
        scheduleModal.job.interval
      );
      await axios.post('/api/v1/settings/jobs/db-backup/schedule', {
        schedule,
      });
      addToast(intl.formatMessage(messages.scheduleEditSaved), {
        appearance: 'success',
        autoDismiss: true,
      });
      dispatchSchedule({ type: 'close' });
      revalidate();
    } catch {
      addToast(intl.formatMessage(messages.scheduleEditFailed), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsSavingSchedule(false);
    }
  };

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.backup),
          intl.formatMessage(globalMessages.settings),
        ]}
      />

      {/* Schedule edit modal */}
      <Transition
        as={Fragment}
        enter="transition-opacity duration-300"
        enterFrom="opacity-0"
        enterTo="opacity-100"
        leave="transition-opacity duration-300"
        leaveFrom="opacity-100"
        leaveTo="opacity-0"
        show={scheduleModal.isOpen}
      >
        <Modal
          title={intl.formatMessage(messages.editSchedule)}
          okText={
            isSavingSchedule
              ? intl.formatMessage(globalMessages.saving)
              : intl.formatMessage(globalMessages.save)
          }
          okDisabled={isSavingSchedule}
          onCancel={() => dispatchSchedule({ type: 'close' })}
          onOk={handleScheduleSave}
        >
          <div className="section">
            <form className="mb-6">
              <div className="form-row">
                <label className="text-label">
                  {intl.formatMessage(messages.currentFrequency)}
                </label>
                <div className="form-input-area mb-1 mt-2">
                  <div>
                    {scheduleModal.job &&
                      cronstrue.toString(scheduleModal.job.cronSchedule)}
                  </div>
                  <div className="text-sm text-gray-500">
                    {scheduleModal.job?.cronSchedule}
                  </div>
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="backupSchedule" className="text-label">
                  {intl.formatMessage(messages.newFrequency)}
                </label>
                <div className="form-input-area">
                  {scheduleModal.job &&
                    scheduleModal.job.interval !== 'fixed' && (
                      <select
                        name="backupSchedule"
                        className="inline"
                        value={scheduleModal.scheduleTotalSeconds}
                        onChange={(e) =>
                          dispatchSchedule({
                            type: 'set',
                            scheduleTotalSeconds: Number(e.target.value),
                          })
                        }
                      >
                        {withCurrentScheduleOption(
                          buildJobScheduleOptions(scheduleModal.job.interval),
                          scheduleModal.scheduleTotalSeconds
                        ).map((option) => (
                          <option
                            value={option.totalSeconds}
                            key={`backupSchedule-${option.totalSeconds}`}
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

      {/* Delete confirmation modal */}
      <Transition
        as={Fragment}
        enter="transition-opacity duration-300"
        enterFrom="opacity-0"
        enterTo="opacity-100"
        leave="transition-opacity duration-300"
        leaveFrom="opacity-100"
        leaveTo="opacity-0"
        show={deleteConfirm.isOpen}
      >
        <Modal
          title={intl.formatMessage(messages.deleteConfirmTitle)}
          okText={
            isDeleting
              ? intl.formatMessage(globalMessages.saving)
              : intl.formatMessage(messages.deleteConfirmOk)
          }
          okButtonType="danger"
          okDisabled={isDeleting}
          onCancel={() => setDeleteConfirm({ isOpen: false, backupId: null })}
          onOk={handleDelete}
        >
          <p>{intl.formatMessage(messages.deleteConfirmBody)}</p>
        </Modal>
      </Transition>

      {/* Configuration section */}
      <div className="mb-6">
        <h3 className="heading">
          {intl.formatMessage(messages.configSection)}
        </h3>
        <p className="description">
          {intl.formatMessage(messages.configSectionDescription)}
        </p>
      </div>
      <div className="section">
        <Formik
          initialValues={{
            enabled: data?.enabled ?? true,
            retention: data?.retention ?? 7,
          }}
          enableReinitialize
          validationSchema={BackupValidationSchema}
          onSubmit={async (values) => {
            try {
              await axios.post('/api/v1/settings/backup', {
                enabled: values.enabled,
                retention: Number(values.retention),
              });
              addToast(intl.formatMessage(messages.settingsSaved), {
                appearance: 'success',
                autoDismiss: true,
              });
              revalidate();
            } catch {
              addToast(intl.formatMessage(messages.settingsFailed), {
                appearance: 'error',
                autoDismiss: true,
              });
            }
          }}
        >
          {({ isSubmitting, errors, touched, values, setFieldValue }) => (
            <Form>
              <div className="form-row">
                <label htmlFor="enabled" className="checkbox-label">
                  <span className="mr-2">
                    {intl.formatMessage(messages.enabledLabel)}
                  </span>
                  <span className="label-tip">
                    {intl.formatMessage(messages.enabledTip)}
                  </span>
                </label>
                <div className="form-input-area">
                  <Field
                    type="checkbox"
                    id="enabled"
                    name="enabled"
                    onChange={() => setFieldValue('enabled', !values.enabled)}
                  />
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="retention" className="text-label">
                  <span>{intl.formatMessage(messages.retentionLabel)}</span>
                  <span className="label-tip">
                    {intl.formatMessage(messages.retentionTip)}
                  </span>
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <Field
                      id="retention"
                      name="retention"
                      type="number"
                      min={1}
                      className="block w-full"
                    />
                  </div>
                  {errors.retention && touched.retention && (
                    <div className="error">{errors.retention}</div>
                  )}
                </div>
              </div>
              <div className="form-row">
                <label className="text-label">
                  <span>{intl.formatMessage(messages.scheduleLabel)}</span>
                  <span className="label-tip">
                    {intl.formatMessage(messages.scheduleTip)}
                  </span>
                </label>
                <div className="form-input-area mt-2 flex items-center gap-3">
                  <div className="text-sm text-white">
                    {dbBackupJob
                      ? cronstrue.toString(dbBackupJob.cronSchedule)
                      : '—'}
                  </div>
                  {dbBackupJob && dbBackupJob.interval !== 'fixed' && (
                    <Button
                      buttonType="warning"
                      buttonSize="sm"
                      type="button"
                      onClick={() =>
                        dispatchSchedule({ type: 'open', job: dbBackupJob })
                      }
                    >
                      <PencilIcon />
                      <span>{intl.formatMessage(messages.editSchedule)}</span>
                    </Button>
                  )}
                  {isBackingUp && <Spinner className="ml-2 h-5 w-5" />}
                </div>
              </div>
              <div className="mt-8 border-t border-gray-700 pt-5">
                <div className="flex justify-end gap-3">
                  <Button
                    buttonType="primary"
                    type="button"
                    disabled={isBackingUp}
                    onClick={handleBackupNow}
                  >
                    {isBackingUp ? (
                      <>
                        <Spinner className="mr-2 h-5 w-5" />
                        <span>{intl.formatMessage(messages.saving)}</span>
                      </>
                    ) : (
                      <>
                        <PlayIcon />
                        <span>{intl.formatMessage(messages.backupNow)}</span>
                      </>
                    )}
                  </Button>
                  <Button
                    buttonType="primary"
                    type="submit"
                    disabled={isSubmitting}
                  >
                    <span>
                      {isSubmitting
                        ? intl.formatMessage(globalMessages.saving)
                        : intl.formatMessage(messages.saveSettings)}
                    </span>
                  </Button>
                </div>
              </div>
            </Form>
          )}
        </Formik>
      </div>

      {/* Restore note + backup dir */}
      {data?.backupDir && (
        <div className="mb-4 rounded-md bg-gray-800 p-4 text-sm text-gray-300">
          <div className="mb-1 font-semibold text-white">
            {intl.formatMessage(messages.backupDirLabel)}
          </div>
          <code className="block break-all text-indigo-300">
            {data.backupDir}
          </code>
          <p className="mt-2">
            {intl.formatMessage(messages.restoreNote, {
              code: (msg: React.ReactNode) => (
                <code key="restore-code" className="bg-gray-700/60 px-1">
                  {msg}
                </code>
              ),
            })}
          </p>
        </div>
      )}

      {/* Backups table */}
      <div className="mb-6">
        <h3 className="heading">
          {intl.formatMessage(messages.backupsSection)}
        </h3>
        <p className="description">
          {intl.formatMessage(messages.backupsSectionDescription)}
        </p>
      </div>
      <div className="section">
        <Table>
          <thead>
            <tr>
              <Table.TH>{intl.formatMessage(messages.colCreatedAt)}</Table.TH>
              <Table.TH className="text-right">
                {intl.formatMessage(messages.colDbSize)}
              </Table.TH>
              <Table.TH className="text-right">
                {intl.formatMessage(messages.colSettingsSize)}
              </Table.TH>
              <Table.TH />
            </tr>
          </thead>
          <Table.TBody>
            {!data && !error ? (
              <tr>
                <Table.TD colSpan={4} alignText="center">
                  <LoadingSpinner />
                </Table.TD>
              </tr>
            ) : !data?.backups || data.backups.length === 0 ? (
              <tr>
                <Table.TD colSpan={4} alignText="center">
                  <p className="description py-4">
                    {intl.formatMessage(messages.noBackups)}
                  </p>
                </Table.TD>
              </tr>
            ) : (
              data.backups.map((backup) => (
                <tr key={`backup-${backup.id}`}>
                  <Table.TD>
                    <div className="text-sm leading-5 text-white">
                      {intl.formatDate(backup.createdAt, {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </div>
                  </Table.TD>
                  <Table.TD alignText="right">
                    <div className="text-sm tabular-nums leading-5 text-white">
                      {formatBytes(backup.dbSize)}
                    </div>
                  </Table.TD>
                  <Table.TD alignText="right">
                    <div className="text-sm tabular-nums leading-5 text-white">
                      {formatBytes(backup.settingsSize)}
                    </div>
                  </Table.TD>
                  <Table.TD alignText="right">
                    {backup.dbSize > 0 && (
                      <a
                        href={`/api/v1/settings/backup/${backup.id}/download?type=db`}
                        download
                        className="mr-2 inline-flex"
                      >
                        <Button
                          buttonType="primary"
                          buttonSize="sm"
                          type="button"
                        >
                          <ArrowDownTrayIcon />
                          <span>{intl.formatMessage(messages.downloadDb)}</span>
                        </Button>
                      </a>
                    )}
                    {backup.settingsSize > 0 && (
                      <a
                        href={`/api/v1/settings/backup/${backup.id}/download?type=settings`}
                        download
                        className="mr-2 inline-flex"
                      >
                        <Button
                          buttonType="primary"
                          buttonSize="sm"
                          type="button"
                        >
                          <ArrowDownTrayIcon />
                          <span>
                            {intl.formatMessage(messages.downloadSettings)}
                          </span>
                        </Button>
                      </a>
                    )}
                    <Button
                      buttonType="danger"
                      buttonSize="sm"
                      type="button"
                      onClick={() =>
                        setDeleteConfirm({ isOpen: true, backupId: backup.id })
                      }
                    >
                      <TrashIcon />
                      <span>{intl.formatMessage(messages.deleteBackup)}</span>
                    </Button>
                  </Table.TD>
                </tr>
              ))
            )}
          </Table.TBody>
        </Table>
      </div>
    </>
  );
};

export default SettingsBackup;
