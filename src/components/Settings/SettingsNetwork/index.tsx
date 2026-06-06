import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import Tooltip from '@app/components/Common/Tooltip';
import SettingsBadge from '@app/components/Settings/SettingsBadge';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { ArrowDownOnSquareIcon } from '@heroicons/react/24/outline';
import type { NetworkSettings } from '@server/lib/settings';
import axios from 'axios';
import { Field, Form, Formik } from 'formik';
import { useIntl } from 'react-intl';
import useSWR, { mutate } from 'swr';
import * as Yup from 'yup';

const messages = defineMessages('components.Settings.SettingsNetwork', {
  toastSettingsSuccess: 'Settings saved successfully!',
  toastSettingsFailure: 'Something went wrong while saving settings.',
  network: 'Network',
  networksettings: 'Network Settings',
  networksettingsDescription:
    'Configure network settings for your Seerr instance.',
  csrfProtection: 'Enable CSRF Protection',
  csrfProtectionTip: 'Set external API access to read-only (requires HTTPS)',
  csrfProtectionHoverTip:
    'Do NOT enable this setting unless you understand what you are doing!',
  trustProxy: 'Enable Proxy Support',
  trustProxyTip:
    'Allow Seerr to correctly register client IP addresses behind a proxy',
  proxyEnabled: 'HTTP(S) Proxy',
  proxyEnabledTip:
    'Send ALL outgoing HTTP/HTTPS requests through a proxy server (host/port). Does NOT enable HTTPS, SSL, or certificate configuration.',
  proxyHostname: 'Proxy Hostname',
  proxyPort: 'Proxy Port',
  proxySsl: 'Use SSL For Proxy',
  proxyUser: 'Proxy Username',
  proxyPassword: 'Proxy Password',
  proxyBypassFilter: 'Proxy Ignored Addresses',
  proxyBypassFilterTip:
    "Use ',' as a separator, and '*.' as a wildcard for subdomains",
  proxyBypassLocalAddresses: 'Bypass Proxy for Local Addresses',
  validationDnsCacheMinTtl: 'You must provide a valid minimum TTL',
  validationDnsCacheMaxTtl: 'You must provide a valid maximum TTL',
  validationProxyPort: 'You must provide a valid port',
  networkDisclaimer:
    'Network parameters from your container/system should be used instead of these settings. See the {docs} for more information.',
  docs: 'documentation',
  forceIpv4First: 'Force IPv4 Resolution First',
  forceIpv4FirstTip:
    'Force Seerr to resolve IPv4 addresses first instead of IPv6',
  dnsCache: 'DNS Cache',
  dnsCacheTip:
    'Enable caching of DNS lookups to optimize performance and avoid making unnecessary API calls',
  dnsCacheHoverTip:
    'Do NOT enable this if you are experiencing issues with DNS lookups',
  dnsCacheForceMinTtl: 'DNS Cache Minimum TTL',
  dnsCacheForceMaxTtl: 'DNS Cache Maximum TTL',
  apiRequestTimeout: 'API Request Timeout',
  apiRequestTimeoutTip:
    'Maximum time (in seconds) to wait for responses from external services like Radarr/Sonarr. Set to 0 for no timeout.',
  validationApiRequestTimeout: 'You must provide a valid timeout value',
  sectionProxyAwarenessTitle: 'Reverse Proxy',
  sectionProxyAwarenessDescription:
    'Control how Seerr handles requests when it runs behind a reverse proxy.',
  sectionSecurityTitle: 'Security',
  sectionSecurityDescription:
    'Harden API access. Only change these if you understand the implications.',
  sectionDnsTitle: 'DNS & Connectivity',
  sectionDnsDescription:
    'Tune DNS resolution and how long Seerr waits for external services.',
  sectionOutboundProxyTitle: 'Outbound Proxy',
  sectionOutboundProxyDescription:
    "Route all of Seerr's outgoing HTTP/HTTPS traffic through a proxy server.",
});

interface ToggleProps {
  id?: string;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  ariaLabel?: string;
}

const Toggle = ({
  id,
  checked,
  onChange,
  disabled,
  ariaLabel,
}: ToggleProps) => (
  <button
    id={id}
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={ariaLabel}
    disabled={disabled}
    onClick={onChange}
    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-gray-800 disabled:cursor-not-allowed disabled:opacity-50 ${
      checked ? 'bg-indigo-600' : 'bg-gray-600'
    }`}
  >
    <span
      aria-hidden="true"
      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
        checked ? 'translate-x-5' : 'translate-x-0'
      }`}
    />
  </button>
);

interface SettingsCardProps {
  title: string;
  description?: string;
  children: React.ReactNode;
}

const SettingsCard = ({ title, description, children }: SettingsCardProps) => (
  <div className="mb-6 overflow-hidden rounded-xl border border-gray-700 bg-gray-800/50 shadow-md ring-1 ring-white/5">
    <div className="border-b border-gray-700 px-5 py-4">
      <h4 className="text-base font-semibold text-white">{title}</h4>
      {description && (
        <p className="mt-0.5 text-sm leading-5 text-gray-400">{description}</p>
      )}
    </div>
    <div className="divide-y divide-gray-700/70 px-5">{children}</div>
  </div>
);

interface SettingRowProps {
  label: string;
  htmlFor?: string;
  description?: React.ReactNode;
  badges?: React.ReactNode;
  control: React.ReactNode;
  alignTop?: boolean;
}

const SettingRow = ({
  label,
  htmlFor,
  description,
  badges,
  control,
  alignTop,
}: SettingRowProps) => (
  <div
    className={`flex flex-col gap-2 py-4 sm:flex-row sm:justify-between sm:gap-6 ${
      alignTop ? 'sm:items-start' : 'sm:items-center'
    }`}
  >
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <label
          htmlFor={htmlFor}
          className="mb-0 cursor-pointer text-sm font-semibold text-gray-100"
        >
          {label}
        </label>
        {badges && <span className="flex flex-wrap gap-1">{badges}</span>}
      </div>
      {description && (
        <p className="mt-1 max-w-2xl text-sm leading-5 text-gray-400">
          {description}
        </p>
      )}
    </div>
    <div
      className={`flex shrink-0 flex-col gap-1 sm:items-end ${
        alignTop ? 'sm:pt-0.5' : ''
      }`}
    >
      {control}
    </div>
  </div>
);

const SettingsNetwork = () => {
  const { addToast } = useToasts();
  const intl = useIntl();
  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<NetworkSettings>('/api/v1/settings/network');

  const NetworkSettingsSchema = Yup.object().shape({
    dnsCacheForceMinTtl: Yup.number().when('dnsCacheEnabled', {
      is: true,
      then: (schema) =>
        schema
          .typeError(intl.formatMessage(messages.validationDnsCacheMinTtl))
          .required(intl.formatMessage(messages.validationDnsCacheMinTtl))
          .min(0),
      otherwise: (schema) => schema.nullable(),
    }),
    dnsCacheForceMaxTtl: Yup.number().when('dnsCacheEnabled', {
      is: true,
      then: (schema) =>
        schema
          .typeError(intl.formatMessage(messages.validationDnsCacheMaxTtl))
          .required(intl.formatMessage(messages.validationDnsCacheMaxTtl))
          .min(-1),
      otherwise: (schema) => schema.nullable(),
    }),
    proxyPort: Yup.number().when('proxyEnabled', {
      is: (proxyEnabled: boolean) => proxyEnabled,
      then: (schema) =>
        schema
          .typeError(intl.formatMessage(messages.validationProxyPort))
          .integer(intl.formatMessage(messages.validationProxyPort))
          .min(1, intl.formatMessage(messages.validationProxyPort))
          .max(65535, intl.formatMessage(messages.validationProxyPort))
          .required(intl.formatMessage(messages.validationProxyPort)),
      otherwise: (schema) => schema.nullable(),
    }),
    apiRequestTimeout: Yup.number()
      .typeError(intl.formatMessage(messages.validationApiRequestTimeout))
      .required(intl.formatMessage(messages.validationApiRequestTimeout))
      .min(0, intl.formatMessage(messages.validationApiRequestTimeout)),
  });

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.network),
          intl.formatMessage(globalMessages.settings),
        ]}
      />
      <div className="mb-6">
        <h3 className="heading">
          {intl.formatMessage(messages.networksettings)}
        </h3>
        <p className="description">
          {intl.formatMessage(messages.networksettingsDescription)}
        </p>
      </div>
      <Formik
        initialValues={{
          csrfProtection: data?.csrfProtection,
          forceIpv4First: data?.forceIpv4First,
          dnsCacheEnabled: data?.dnsCache.enabled,
          dnsCacheForceMinTtl: data?.dnsCache.forceMinTtl,
          dnsCacheForceMaxTtl: data?.dnsCache.forceMaxTtl,
          trustProxy: data?.trustProxy,
          proxyEnabled: data?.proxy?.enabled,
          proxyHostname: data?.proxy?.hostname,
          proxyPort: data?.proxy?.port,
          proxySsl: data?.proxy?.useSsl,
          proxyUser: data?.proxy?.user,
          proxyPassword: data?.proxy?.password,
          proxyBypassFilter: data?.proxy?.bypassFilter,
          proxyBypassLocalAddresses: data?.proxy?.bypassLocalAddresses,
          apiRequestTimeout:
            data?.apiRequestTimeout !== undefined
              ? data.apiRequestTimeout / 1000
              : 10,
        }}
        enableReinitialize
        validationSchema={NetworkSettingsSchema}
        onSubmit={async (values) => {
          try {
            await axios.post('/api/v1/settings/network', {
              csrfProtection: values.csrfProtection,
              forceIpv4First: values.forceIpv4First,
              trustProxy: values.trustProxy,
              dnsCache: {
                enabled: values.dnsCacheEnabled,
                forceMinTtl: Number(values.dnsCacheForceMinTtl),
                forceMaxTtl: Number(values.dnsCacheForceMaxTtl),
              },
              proxy: {
                enabled: values.proxyEnabled,
                hostname: values.proxyHostname,
                port: Number(values.proxyPort),
                useSsl: values.proxySsl,
                user: values.proxyUser,
                password: values.proxyPassword,
                bypassFilter: values.proxyBypassFilter,
                bypassLocalAddresses: values.proxyBypassLocalAddresses,
              },
              apiRequestTimeout: Number(values.apiRequestTimeout) * 1000,
            });
            mutate('/api/v1/settings/public');
            mutate('/api/v1/status');

            addToast(intl.formatMessage(messages.toastSettingsSuccess), {
              autoDismiss: true,
              appearance: 'success',
            });
          } catch {
            addToast(intl.formatMessage(messages.toastSettingsFailure), {
              autoDismiss: true,
              appearance: 'error',
            });
          } finally {
            revalidate();
          }
        }}
      >
        {({
          errors,
          touched,
          isSubmitting,
          isValid,
          values,
          setFieldValue,
        }) => {
          return (
            <Form className="mt-6" data-testid="settings-network-form">
              <SettingsCard
                title={intl.formatMessage(messages.sectionProxyAwarenessTitle)}
                description={intl.formatMessage(
                  messages.sectionProxyAwarenessDescription
                )}
              >
                <SettingRow
                  htmlFor="trustProxy"
                  label={intl.formatMessage(messages.trustProxy)}
                  description={intl.formatMessage(messages.trustProxyTip)}
                  badges={<SettingsBadge badgeType="restartRequired" />}
                  control={
                    <Toggle
                      id="trustProxy"
                      ariaLabel={intl.formatMessage(messages.trustProxy)}
                      checked={!!values.trustProxy}
                      onChange={() =>
                        setFieldValue('trustProxy', !values.trustProxy)
                      }
                    />
                  }
                />
              </SettingsCard>

              <SettingsCard
                title={intl.formatMessage(messages.sectionSecurityTitle)}
                description={intl.formatMessage(
                  messages.sectionSecurityDescription
                )}
              >
                <SettingRow
                  htmlFor="csrfProtection"
                  label={intl.formatMessage(messages.csrfProtection)}
                  description={intl.formatMessage(messages.csrfProtectionTip)}
                  badges={
                    <>
                      <SettingsBadge badgeType="advanced" />
                      <SettingsBadge badgeType="restartRequired" />
                    </>
                  }
                  control={
                    <Tooltip
                      content={intl.formatMessage(
                        messages.csrfProtectionHoverTip
                      )}
                    >
                      <Toggle
                        id="csrfProtection"
                        ariaLabel={intl.formatMessage(messages.csrfProtection)}
                        checked={!!values.csrfProtection}
                        onChange={() =>
                          setFieldValue(
                            'csrfProtection',
                            !values.csrfProtection
                          )
                        }
                      />
                    </Tooltip>
                  }
                />
              </SettingsCard>

              <SettingsCard
                title={intl.formatMessage(messages.sectionDnsTitle)}
                description={intl.formatMessage(messages.sectionDnsDescription)}
              >
                <SettingRow
                  htmlFor="forceIpv4First"
                  label={intl.formatMessage(messages.forceIpv4First)}
                  description={intl.formatMessage(messages.forceIpv4FirstTip)}
                  badges={
                    <>
                      <SettingsBadge badgeType="advanced" />
                      <SettingsBadge badgeType="restartRequired" />
                      <SettingsBadge badgeType="experimental" />
                    </>
                  }
                  control={
                    <Toggle
                      id="forceIpv4First"
                      ariaLabel={intl.formatMessage(messages.forceIpv4First)}
                      checked={!!values.forceIpv4First}
                      onChange={() =>
                        setFieldValue('forceIpv4First', !values.forceIpv4First)
                      }
                    />
                  }
                />
                <SettingRow
                  htmlFor="dnsCacheEnabled"
                  label={intl.formatMessage(messages.dnsCache)}
                  description={intl.formatMessage(messages.dnsCacheTip)}
                  badges={
                    <>
                      <SettingsBadge badgeType="advanced" />
                      <SettingsBadge badgeType="restartRequired" />
                      <SettingsBadge badgeType="experimental" />
                    </>
                  }
                  control={
                    <Tooltip
                      content={intl.formatMessage(messages.dnsCacheHoverTip)}
                    >
                      <Toggle
                        id="dnsCacheEnabled"
                        ariaLabel={intl.formatMessage(messages.dnsCache)}
                        checked={!!values.dnsCacheEnabled}
                        onChange={() =>
                          setFieldValue(
                            'dnsCacheEnabled',
                            !values.dnsCacheEnabled
                          )
                        }
                      />
                    </Tooltip>
                  }
                />
                {values.dnsCacheEnabled && (
                  <div className="py-4">
                    <div className="divide-y divide-gray-700/60 rounded-lg border border-gray-700/60 bg-gray-900/40 px-4">
                      <SettingRow
                        alignTop
                        htmlFor="dnsCacheForceMinTtl"
                        label={intl.formatMessage(messages.dnsCacheForceMinTtl)}
                        control={
                          <>
                            <Field
                              id="dnsCacheForceMinTtl"
                              name="dnsCacheForceMinTtl"
                              type="text"
                              inputMode="numeric"
                              className="short"
                            />
                            {errors.dnsCacheForceMinTtl &&
                              touched.dnsCacheForceMinTtl &&
                              typeof errors.dnsCacheForceMinTtl ===
                                'string' && (
                                <div className="error">
                                  {errors.dnsCacheForceMinTtl}
                                </div>
                              )}
                          </>
                        }
                      />
                      <SettingRow
                        alignTop
                        htmlFor="dnsCacheForceMaxTtl"
                        label={intl.formatMessage(messages.dnsCacheForceMaxTtl)}
                        control={
                          <>
                            <Field
                              id="dnsCacheForceMaxTtl"
                              name="dnsCacheForceMaxTtl"
                              type="text"
                              inputMode="numeric"
                              className="short"
                            />
                            {errors.dnsCacheForceMaxTtl &&
                              touched.dnsCacheForceMaxTtl &&
                              typeof errors.dnsCacheForceMaxTtl ===
                                'string' && (
                                <div className="error">
                                  {errors.dnsCacheForceMaxTtl}
                                </div>
                              )}
                          </>
                        }
                      />
                    </div>
                  </div>
                )}
                <SettingRow
                  alignTop
                  htmlFor="apiRequestTimeout"
                  label={intl.formatMessage(messages.apiRequestTimeout)}
                  description={intl.formatMessage(
                    messages.apiRequestTimeoutTip
                  )}
                  badges={<SettingsBadge badgeType="restartRequired" />}
                  control={
                    <>
                      <Field
                        id="apiRequestTimeout"
                        name="apiRequestTimeout"
                        type="text"
                        inputMode="numeric"
                        className="short"
                      />
                      {errors.apiRequestTimeout &&
                        touched.apiRequestTimeout &&
                        typeof errors.apiRequestTimeout === 'string' && (
                          <div className="error">
                            {errors.apiRequestTimeout}
                          </div>
                        )}
                    </>
                  }
                />
              </SettingsCard>

              <SettingsCard
                title={intl.formatMessage(messages.sectionOutboundProxyTitle)}
                description={intl.formatMessage(
                  messages.sectionOutboundProxyDescription
                )}
              >
                <SettingRow
                  htmlFor="proxyEnabled"
                  label={intl.formatMessage(messages.proxyEnabled)}
                  description={intl.formatMessage(messages.proxyEnabledTip)}
                  badges={
                    <>
                      <SettingsBadge badgeType="advanced" />
                      <SettingsBadge badgeType="restartRequired" />
                    </>
                  }
                  control={
                    <Toggle
                      id="proxyEnabled"
                      ariaLabel={intl.formatMessage(messages.proxyEnabled)}
                      checked={!!values.proxyEnabled}
                      onChange={() =>
                        setFieldValue('proxyEnabled', !values.proxyEnabled)
                      }
                    />
                  }
                />
                {values.proxyEnabled && (
                  <div className="py-4">
                    <div className="divide-y divide-gray-700/60 rounded-lg border border-gray-700/60 bg-gray-900/40 px-4">
                      <SettingRow
                        alignTop
                        htmlFor="proxyHostname"
                        label={intl.formatMessage(messages.proxyHostname)}
                        control={
                          <>
                            <div className="form-input-field w-full sm:w-72">
                              <Field
                                id="proxyHostname"
                                name="proxyHostname"
                                type="text"
                              />
                            </div>
                            {errors.proxyHostname &&
                              touched.proxyHostname &&
                              typeof errors.proxyHostname === 'string' && (
                                <div className="error">
                                  {errors.proxyHostname}
                                </div>
                              )}
                          </>
                        }
                      />
                      <SettingRow
                        alignTop
                        htmlFor="proxyPort"
                        label={intl.formatMessage(messages.proxyPort)}
                        control={
                          <>
                            <Field
                              id="proxyPort"
                              name="proxyPort"
                              type="text"
                              inputMode="numeric"
                              className="short"
                            />
                            {errors.proxyPort &&
                              touched.proxyPort &&
                              typeof errors.proxyPort === 'string' && (
                                <div className="error">{errors.proxyPort}</div>
                              )}
                          </>
                        }
                      />
                      <SettingRow
                        htmlFor="proxySsl"
                        label={intl.formatMessage(messages.proxySsl)}
                        control={
                          <Toggle
                            id="proxySsl"
                            ariaLabel={intl.formatMessage(messages.proxySsl)}
                            checked={!!values.proxySsl}
                            onChange={() =>
                              setFieldValue('proxySsl', !values.proxySsl)
                            }
                          />
                        }
                      />
                      <SettingRow
                        alignTop
                        htmlFor="proxyUser"
                        label={intl.formatMessage(messages.proxyUser)}
                        control={
                          <>
                            <div className="form-input-field w-full sm:w-72">
                              <Field
                                id="proxyUser"
                                name="proxyUser"
                                type="text"
                              />
                            </div>
                            {errors.proxyUser &&
                              touched.proxyUser &&
                              typeof errors.proxyUser === 'string' && (
                                <div className="error">{errors.proxyUser}</div>
                              )}
                          </>
                        }
                      />
                      <SettingRow
                        alignTop
                        htmlFor="proxyPassword"
                        label={intl.formatMessage(messages.proxyPassword)}
                        control={
                          <>
                            <div className="form-input-field w-full sm:w-72">
                              <Field
                                id="proxyPassword"
                                name="proxyPassword"
                                type="password"
                              />
                            </div>
                            {errors.proxyPassword &&
                              touched.proxyPassword &&
                              typeof errors.proxyPassword === 'string' && (
                                <div className="error">
                                  {errors.proxyPassword}
                                </div>
                              )}
                          </>
                        }
                      />
                      <SettingRow
                        alignTop
                        htmlFor="proxyBypassFilter"
                        label={intl.formatMessage(messages.proxyBypassFilter)}
                        description={intl.formatMessage(
                          messages.proxyBypassFilterTip
                        )}
                        control={
                          <>
                            <div className="form-input-field w-full sm:w-72">
                              <Field
                                id="proxyBypassFilter"
                                name="proxyBypassFilter"
                                type="text"
                              />
                            </div>
                            {errors.proxyBypassFilter &&
                              touched.proxyBypassFilter &&
                              typeof errors.proxyBypassFilter === 'string' && (
                                <div className="error">
                                  {errors.proxyBypassFilter}
                                </div>
                              )}
                          </>
                        }
                      />
                      <SettingRow
                        htmlFor="proxyBypassLocalAddresses"
                        label={intl.formatMessage(
                          messages.proxyBypassLocalAddresses
                        )}
                        control={
                          <Toggle
                            id="proxyBypassLocalAddresses"
                            ariaLabel={intl.formatMessage(
                              messages.proxyBypassLocalAddresses
                            )}
                            checked={!!values.proxyBypassLocalAddresses}
                            onChange={() =>
                              setFieldValue(
                                'proxyBypassLocalAddresses',
                                !values.proxyBypassLocalAddresses
                              )
                            }
                          />
                        }
                      />
                    </div>
                  </div>
                )}
              </SettingsCard>

              <div className="actions">
                <div className="flex justify-end">
                  <span className="inline-flex rounded-md shadow-sm">
                    <Button
                      buttonType="primary"
                      type="submit"
                      disabled={isSubmitting || !isValid}
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
    </>
  );
};

export default SettingsNetwork;
