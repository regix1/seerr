import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { ArrowDownOnSquareIcon, BeakerIcon } from '@heroicons/react/24/outline';
import axios from 'axios';
import { Field, Form, Formik } from 'formik';
import Link from 'next/link';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';
import * as Yup from 'yup';

const messages = defineMessages('components.Settings', {
  fileflows: 'FileFlows',
  fileflowssettings: 'FileFlows Settings',
  fileflowssettingsDescription:
    'Optionally defer the "available" status and notification for media managed by Radarr/Sonarr until FileFlows has finished post-processing the file. When enabled, media that FileFlows is still processing is kept in a processing state until the next scan after processing completes.',
  enable: 'Enable',
  enableTip:
    'Hold availability of media that FileFlows is still processing. Requires Radarr/Sonarr scanning.',
  hostname: 'Hostname or IP Address',
  port: 'Port',
  ssl: 'Use SSL',
  urlBase: 'URL Base',
  apiKey: 'Access Token',
  apiKeyTip:
    'Only required if your FileFlows server has an access token configured. Most LAN installs leave this blank.',
  validationHostnameRequired: 'You must provide a valid hostname or IP address',
  validationPortRequired: 'You must provide a valid port number',
  testFileFlows: 'Test',
  toastFileFlowsTestSuccess:
    'FileFlows connection established ({processing} processing, {queue} queued).',
  toastFileFlowsTestFailure: 'Could not connect to FileFlows.',
  toastSettingsSuccess: 'FileFlows settings saved successfully!',
  toastSettingsFailure: 'Something went wrong while saving settings.',
  mappingsTitle: 'FileFlows Mappings',
  mappingsDescription:
    'A live view of every file FileFlows is processing and the media it resolves to. When a file resolves to a title here, the “Processing in FileFlows” badge shows on that title.',
  mappingsProcessingFiles: 'Processing files',
  mappingsNoFiles: 'FileFlows is not processing any files right now.',
  mappingsColFile: 'File',
  mappingsColMedia: 'Resolved media',
  mappingsColSource: 'Resolved via',
  mappingsColBadge: 'Badge active',
  mappingsView: 'View',
  mappingsUnresolved: 'Unresolved',
  mappingsSourceFileflows: 'FileFlows metadata',
  mappingsSourceArr: 'Radarr/Sonarr parser',
  mappingsSourceNone: '—',
  mappingsYes: 'Yes',
  mappingsNo: 'No',
});

interface FileFlowsSettings {
  enabled: boolean;
  hostname: string;
  port: number;
  useSsl: boolean;
  apiKey: string;
  urlBase: string;
}

interface FileFlowsFileMapping {
  file: string;
  title: string | null;
  mediaType: 'movie' | 'tv' | null;
  tmdbId: number | null;
  tvdbId: number | null;
  source: 'fileflows' | 'arr-parse' | 'none';
  badgeActive: boolean;
}

interface FileFlowsMappingsResponse {
  enabled: boolean;
  processing: number;
  queue: number;
  files: FileFlowsFileMapping[];
}

const SettingsFileFlows = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [isTesting, setIsTesting] = useState(false);

  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<FileFlowsSettings>('/api/v1/settings/fileflows');

  const { data: mappings } = useSWR<FileFlowsMappingsResponse>(
    data?.enabled ? '/api/v1/settings/fileflows/mappings' : null,
    { refreshInterval: 10000 }
  );

  const FileFlowsSettingsSchema = Yup.object().shape({
    hostname: Yup.string().when('enabled', {
      is: true,
      then: (schema) =>
        schema.required(
          intl.formatMessage(messages.validationHostnameRequired)
        ),
      otherwise: (schema) => schema.nullable(),
    }),
    port: Yup.number()
      .typeError(intl.formatMessage(messages.validationPortRequired))
      .when('enabled', {
        is: true,
        then: (schema) =>
          schema
            .required(intl.formatMessage(messages.validationPortRequired))
            .min(1)
            .max(65535),
      }),
  });

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.fileflows),
          intl.formatMessage(globalMessages.settings),
        ]}
      />
      <div className="mb-6">
        <h3 className="heading">
          {intl.formatMessage(messages.fileflowssettings)}
        </h3>
        <p className="description">
          {intl.formatMessage(messages.fileflowssettingsDescription)}
        </p>
      </div>
      <div className="section">
        <Formik
          initialValues={{
            enabled: data?.enabled ?? false,
            hostname: data?.hostname ?? '',
            port: data?.port ?? 19200,
            useSsl: data?.useSsl ?? false,
            urlBase: data?.urlBase ?? '',
            apiKey: data?.apiKey ?? '',
          }}
          enableReinitialize
          validationSchema={FileFlowsSettingsSchema}
          onSubmit={async (values) => {
            try {
              await axios.post('/api/v1/settings/fileflows', {
                enabled: values.enabled,
                hostname: values.hostname,
                port: Number(values.port),
                useSsl: values.useSsl,
                urlBase: values.urlBase,
                apiKey: values.apiKey,
              });

              addToast(intl.formatMessage(messages.toastSettingsSuccess), {
                appearance: 'success',
                autoDismiss: true,
              });
            } catch {
              addToast(intl.formatMessage(messages.toastSettingsFailure), {
                appearance: 'error',
                autoDismiss: true,
              });
            } finally {
              revalidate();
            }
          }}
        >
          {({
            errors,
            touched,
            values,
            isSubmitting,
            isValid,
            setFieldValue,
          }) => {
            const testConnection = async () => {
              setIsTesting(true);
              try {
                const response = await axios.post<{
                  processing: number;
                  queue: number;
                }>('/api/v1/settings/fileflows/test', {
                  hostname: values.hostname,
                  port: Number(values.port),
                  useSsl: values.useSsl,
                  urlBase: values.urlBase,
                  apiKey: values.apiKey,
                });

                addToast(
                  intl.formatMessage(messages.toastFileFlowsTestSuccess, {
                    processing: response.data.processing,
                    queue: response.data.queue,
                  }),
                  { appearance: 'success', autoDismiss: true }
                );
              } catch {
                addToast(
                  intl.formatMessage(messages.toastFileFlowsTestFailure),
                  { appearance: 'error', autoDismiss: true }
                );
              } finally {
                setIsTesting(false);
              }
            };

            return (
              <Form className="section" data-testid="settings-fileflows-form">
                <div className="form-row">
                  <label htmlFor="enabled" className="checkbox-label">
                    <span className="mr-2">
                      {intl.formatMessage(messages.enable)}
                    </span>
                    <span className="label-tip">
                      {intl.formatMessage(messages.enableTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <Field
                      type="checkbox"
                      id="enabled"
                      name="enabled"
                      onChange={() => {
                        setFieldValue('enabled', !values.enabled);
                      }}
                    />
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="hostname" className="text-label">
                    {intl.formatMessage(messages.hostname)}
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <span className="protocol">
                        {values.useSsl ? 'https://' : 'http://'}
                      </span>
                      <Field
                        id="hostname"
                        name="hostname"
                        type="text"
                        inputMode="url"
                        className="rounded-r-only"
                      />
                    </div>
                    {errors.hostname &&
                      touched.hostname &&
                      typeof errors.hostname === 'string' && (
                        <div className="error">{errors.hostname}</div>
                      )}
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="port" className="text-label">
                    {intl.formatMessage(messages.port)}
                  </label>
                  <div className="form-input-area">
                    <Field
                      id="port"
                      name="port"
                      type="text"
                      inputMode="numeric"
                      className="short"
                    />
                    {errors.port &&
                      touched.port &&
                      typeof errors.port === 'string' && (
                        <div className="error">{errors.port}</div>
                      )}
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="useSsl" className="checkbox-label">
                    {intl.formatMessage(messages.ssl)}
                  </label>
                  <div className="form-input-area">
                    <Field
                      type="checkbox"
                      id="useSsl"
                      name="useSsl"
                      onChange={() => {
                        setFieldValue('useSsl', !values.useSsl);
                      }}
                    />
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="urlBase" className="text-label">
                    {intl.formatMessage(messages.urlBase)}
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field id="urlBase" name="urlBase" type="text" />
                    </div>
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="apiKey" className="text-label">
                    <span className="mr-2">
                      {intl.formatMessage(messages.apiKey)}
                    </span>
                    <span className="label-tip">
                      {intl.formatMessage(messages.apiKeyTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field
                        id="apiKey"
                        name="apiKey"
                        type="password"
                        autoComplete="one-time-code"
                      />
                    </div>
                  </div>
                </div>
                <div className="actions">
                  <div className="flex justify-end">
                    <span className="ml-3 inline-flex rounded-md shadow-sm">
                      <Button
                        buttonType="warning"
                        type="button"
                        disabled={isTesting || !values.hostname}
                        onClick={testConnection}
                      >
                        <BeakerIcon />
                        <span>
                          {isTesting
                            ? intl.formatMessage(globalMessages.testing)
                            : intl.formatMessage(messages.testFileFlows)}
                        </span>
                      </Button>
                    </span>
                    <span className="ml-3 inline-flex rounded-md shadow-sm">
                      <Button
                        buttonType="primary"
                        type="submit"
                        disabled={isSubmitting || !isValid || isTesting}
                      >
                        <ArrowDownOnSquareIcon />
                        <span>
                          {isSubmitting
                            ? intl.formatMessage(globalMessages.saving)
                            : intl.formatMessage(globalMessages.save)}
                        </span>
                      </Button>
                    </span>
                  </div>
                </div>
              </Form>
            );
          }}
        </Formik>
      </div>
      {data?.enabled && (
        <div className="mt-10">
          <div className="mb-4">
            <h3 className="heading">
              {intl.formatMessage(messages.mappingsTitle)}
            </h3>
            <p className="description">
              {intl.formatMessage(messages.mappingsDescription)}
            </p>
          </div>

          <div className="rounded-lg bg-gray-800 p-4">
            <h4 className="mb-3 text-sm font-semibold text-gray-100">
              {intl.formatMessage(messages.mappingsProcessingFiles)} (
              {mappings?.processing ?? 0})
            </h4>
            {mappings && mappings.files.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wider text-gray-400">
                      <th className="py-2 pr-4 font-medium">
                        {intl.formatMessage(messages.mappingsColFile)}
                      </th>
                      <th className="py-2 pr-4 font-medium">
                        {intl.formatMessage(messages.mappingsColMedia)}
                      </th>
                      <th className="py-2 pr-4 font-medium">
                        {intl.formatMessage(messages.mappingsColSource)}
                      </th>
                      <th className="py-2 font-medium">
                        {intl.formatMessage(messages.mappingsColBadge)}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-700">
                    {mappings.files.map((file, index) => (
                      <tr key={`ff-file-${index}`}>
                        <td className="max-w-xs truncate py-2 pr-4 font-mono text-xs text-gray-300">
                          {file.file}
                        </td>
                        <td className="py-2 pr-4">
                          {file.tmdbId && file.mediaType ? (
                            <Link
                              href={`/${file.mediaType}/${file.tmdbId}`}
                              className="text-indigo-400 hover:underline"
                            >
                              {file.title ||
                                intl.formatMessage(messages.mappingsView)}
                            </Link>
                          ) : file.title ? (
                            <span className="text-gray-300">{file.title}</span>
                          ) : (
                            <span className="text-gray-500">
                              {intl.formatMessage(messages.mappingsUnresolved)}
                            </span>
                          )}
                        </td>
                        <td className="py-2 pr-4 text-xs text-gray-400">
                          {file.source === 'fileflows'
                            ? intl.formatMessage(
                                messages.mappingsSourceFileflows
                              )
                            : file.source === 'arr-parse'
                              ? intl.formatMessage(messages.mappingsSourceArr)
                              : intl.formatMessage(messages.mappingsSourceNone)}
                        </td>
                        <td className="py-2">
                          <Badge
                            badgeType={file.badgeActive ? 'success' : 'default'}
                          >
                            {file.badgeActive
                              ? intl.formatMessage(messages.mappingsYes)
                              : intl.formatMessage(messages.mappingsNo)}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-gray-400">
                {intl.formatMessage(messages.mappingsNoFiles)}
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
};

export default SettingsFileFlows;
