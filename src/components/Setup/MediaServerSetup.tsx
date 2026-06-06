import Button from '@app/components/Common/Button';
import Tooltip from '@app/components/Common/Tooltip';
import defineMessages from '@app/utils/defineMessages';
import {
  CheckCircleIcon,
  InformationCircleIcon,
} from '@heroicons/react/24/solid';
import { ApiErrorCode } from '@server/constants/error';
import { MediaServerType, ServerType } from '@server/constants/server';
// MediaServerType used for auth endpoint routing; ServerType used for display labels
import useToasts from '@app/hooks/useToasts';
import axios from 'axios';
import { Field, Form, Formik } from 'formik';
import { FormattedMessage, useIntl } from 'react-intl';
import validator from 'validator';
import * as Yup from 'yup';

const messages = defineMessages('components.Setup.MediaServerSetup', {
  username: 'Username',
  password: 'Password',
  hostname: 'Server URL',
  port: 'Port',
  enablessl: 'Use SSL',
  urlBase: 'URL Base',
  email: 'Email Address',
  emailtooltip:
    'Address does not need to be associated with your media server instance.',
  validationhostrequired: 'Server URL required',
  validationhostformat: 'Valid URL required',
  validationemailrequired: 'You must provide a valid email address',
  validationemailformat: 'Valid email required',
  validationusernamerequired: 'Username required',
  validationPasswordRequired: 'You must provide a password',
  validationPortRequired: 'You must provide a valid port number',
  validationUrlBaseLeadingSlash: 'URL base must have a leading slash',
  validationUrlBaseTrailingSlash: 'URL base must not end in a trailing slash',
  loginerror: 'Something went wrong while trying to sign in.',
  adminerror: 'You must use an admin account to sign in.',
  noadminerror: 'No admin user found on the server.',
  credentialerror: 'The username or password is incorrect.',
  invalidurlerror: 'Unable to connect to the media server.',
  signingin: 'Signing In…',
  signin: 'Sign In',
  probing: 'Detecting server…',
  detectedAs: 'Connected to: {productName}',
  couldNotDetect:
    'Could not detect server type. Please verify the URL and port.',
  urlBaseHelp:
    'If you set a Base URL in your media server, enter it here (e.g. /jellyfin or /emby). Leave blank otherwise.',
  back: 'Go back',
});

interface ProbeResult {
  brand: 'jellyfin' | 'emby' | null;
  productName: string;
  serverName: string;
  version: string;
  serverId: string;
}

interface MediaServerSetupProps {
  revalidate: () => void;
  onCancel?: () => void;
  /** Called after successful auth with the brand that was detected and saved. */
  onDetected?: (serverType: MediaServerType) => void;
}

function MediaServerSetup({
  revalidate,
  onCancel,
  onDetected,
}: MediaServerSetupProps) {
  const toasts = useToasts();
  const intl = useIntl();

  const LoginSchema = Yup.object().shape({
    hostname: Yup.string().required(
      intl.formatMessage(messages.validationhostrequired)
    ),
    port: Yup.number().required(
      intl.formatMessage(messages.validationPortRequired)
    ),
    urlBase: Yup.string()
      .test(
        'leading-slash',
        intl.formatMessage(messages.validationUrlBaseLeadingSlash),
        (value) => !value || value.startsWith('/')
      )
      .test(
        'trailing-slash',
        intl.formatMessage(messages.validationUrlBaseTrailingSlash),
        (value) => !value || !value.endsWith('/')
      ),
    email: Yup.string()
      .test(
        'email',
        intl.formatMessage(messages.validationemailformat),
        (value) => !value || validator.isEmail(value, { require_tld: false })
      )
      .required(intl.formatMessage(messages.validationemailrequired)),
    username: Yup.string().required(
      intl.formatMessage(messages.validationusernamerequired)
    ),
    password: Yup.string(),
  });

  return (
    <Formik
      initialValues={{
        username: '',
        password: '',
        hostname: '',
        port: 8096,
        useSsl: false,
        urlBase: '',
        email: '',
        probeResult: null as ProbeResult | null,
        isProbing: false,
        probeError: '',
      }}
      validationSchema={LoginSchema}
      onSubmit={async (values) => {
        if (!values.probeResult?.brand) {
          toasts.addToast(intl.formatMessage(messages.couldNotDetect), {
            autoDismiss: true,
            appearance: 'error',
          });
          return;
        }

        try {
          const authEndpoint =
            values.probeResult.brand === 'emby'
              ? '/api/v1/auth/emby'
              : '/api/v1/auth/jellyfin';

          const serverType =
            values.probeResult.brand === 'emby'
              ? MediaServerType.EMBY
              : MediaServerType.JELLYFIN;

          await axios.post(authEndpoint, {
            username: values.username,
            password: values.password,
            hostname: values.hostname,
            port: values.port,
            useSsl: values.useSsl,
            urlBase: values.urlBase,
            email: values.email,
            serverType,
          });

          // Bug 5 fix: surface the detected brand to the parent so that step 3
          // renders the correct settings panel (Emby vs Jellyfin) without
          // relying on SWR revalidation racing against setCurrentStep.
          if (onDetected) {
            onDetected(serverType);
          }
        } catch (e) {
          let errorMessage = messages.loginerror;
          const errCode = (e as { response?: { data?: { message?: string } } })
            ?.response?.data?.message;
          switch (errCode) {
            case ApiErrorCode.InvalidUrl:
              errorMessage = messages.invalidurlerror;
              break;
            case ApiErrorCode.InvalidCredentials:
              errorMessage = messages.credentialerror;
              break;
            case ApiErrorCode.NotAdmin:
              errorMessage = messages.adminerror;
              break;
            case ApiErrorCode.NoAdminUser:
              errorMessage = messages.noadminerror;
              break;
          }

          toasts.addToast(intl.formatMessage(errorMessage), {
            autoDismiss: true,
            appearance: 'error',
          });
        } finally {
          revalidate();
        }
      }}
    >
      {({ errors, touched, values, setFieldValue, isSubmitting, isValid }) => {
        const handleProbe = async () => {
          await setFieldValue('isProbing', true);
          await setFieldValue('probeResult', null);
          await setFieldValue('probeError', '');

          try {
            const response = await axios.post<ProbeResult>(
              '/api/v1/settings/probe',
              {
                hostname: values.hostname,
                port: values.port,
                useSsl: values.useSsl,
                urlBase: values.urlBase || undefined,
              }
            );

            if (!response.data.brand) {
              await setFieldValue(
                'probeError',
                intl.formatMessage(messages.couldNotDetect)
              );
            } else {
              await setFieldValue('probeResult', response.data);
            }
          } catch {
            await setFieldValue(
              'probeError',
              intl.formatMessage(messages.couldNotDetect)
            );
          } finally {
            await setFieldValue('isProbing', false);
          }
        };

        const brandLabel =
          values.probeResult?.brand === 'emby'
            ? ServerType.EMBY
            : values.probeResult?.brand === 'jellyfin'
              ? ServerType.JELLYFIN
              : null;

        const detectedProductName = values.probeResult?.productName
          ? `${brandLabel ?? values.probeResult.productName} ${values.probeResult.version}`
          : null;

        return (
          <Form>
            <div className="sm:border-t sm:border-gray-800">
              <div className="flex flex-col sm:flex-row sm:gap-4">
                <div className="w-full">
                  <label htmlFor="hostname" className="text-label">
                    {intl.formatMessage(messages.hostname)}
                  </label>
                  <div className="mb-2 mt-1 sm:col-span-2 sm:mb-0 sm:mt-0">
                    <div className="flex rounded-md shadow-sm">
                      <span className="inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-gray-100 sm:text-sm">
                        {values.useSsl ? 'https://' : 'http://'}
                      </span>
                      <Field
                        id="hostname"
                        name="hostname"
                        type="text"
                        className="rounded-r-only flex-1"
                        placeholder={intl.formatMessage(messages.hostname)}
                        autoComplete="off"
                        data-form-type="other"
                        data-1pignore="true"
                        data-lpignore="true"
                        data-bwignore="true"
                      />
                    </div>
                    {errors.hostname && touched.hostname && (
                      <div className="error">{errors.hostname}</div>
                    )}
                  </div>
                </div>
                <div className="flex-1">
                  <label htmlFor="port" className="text-label">
                    {intl.formatMessage(messages.port)}
                  </label>
                  <div className="mt-1 sm:mt-0">
                    <Field
                      id="port"
                      name="port"
                      inputMode="numeric"
                      type="text"
                      className="short flex-1"
                      placeholder={intl.formatMessage(messages.port)}
                    />
                    {errors.port && touched.port && (
                      <div className="error">{errors.port}</div>
                    )}
                  </div>
                </div>
              </div>
              <label htmlFor="useSsl" className="text-label mt-2">
                {intl.formatMessage(messages.enablessl)}
              </label>
              <div className="mb-2 mt-1 sm:col-span-2">
                <div className="flex rounded-md shadow-sm">
                  <Field
                    id="useSsl"
                    name="useSsl"
                    type="checkbox"
                    onChange={() => {
                      setFieldValue('useSsl', !values.useSsl);
                      setFieldValue('port', values.useSsl ? 8096 : 443);
                    }}
                  />
                </div>
              </div>
              <label
                htmlFor="urlBase"
                className="text-label mt-1 inline-flex gap-1 align-middle"
              >
                {intl.formatMessage(messages.urlBase)}
                <span className="label-tip">
                  <Tooltip content={intl.formatMessage(messages.urlBaseHelp)}>
                    <span className="tooltip-trigger">
                      <InformationCircleIcon className="h-4 w-4" />
                    </span>
                  </Tooltip>
                </span>
              </label>
              <div className="mb-2 mt-1 sm:col-span-2 sm:mt-0">
                <div className="flex rounded-md shadow-sm">
                  <Field
                    type="text"
                    inputMode="url"
                    id="urlBase"
                    name="urlBase"
                    placeholder={intl.formatMessage(messages.urlBase)}
                  />
                </div>
                {errors.urlBase && touched.urlBase && (
                  <div className="error">{errors.urlBase}</div>
                )}
              </div>

              {/* Probe / detect button and result */}
              <div className="mb-4 mt-2 flex items-center gap-3">
                <Button
                  buttonType="default"
                  type="button"
                  disabled={
                    !values.hostname || !values.port || values.isProbing
                  }
                  onClick={() => void handleProbe()}
                >
                  {values.isProbing
                    ? intl.formatMessage(messages.probing)
                    : 'Detect Server Type'}
                </Button>
                {values.probeResult?.brand && detectedProductName && (
                  <span className="flex items-center gap-1 text-sm text-green-400">
                    <CheckCircleIcon className="h-4 w-4" />
                    {intl.formatMessage(messages.detectedAs, {
                      productName: detectedProductName,
                    })}
                  </span>
                )}
                {values.probeError && (
                  <span className="text-sm text-red-400">
                    {values.probeError}
                  </span>
                )}
              </div>

              <label
                htmlFor="email"
                className="text-label inline-flex gap-1 align-middle"
              >
                {intl.formatMessage(messages.email)}
                <span className="label-tip">
                  <Tooltip content={intl.formatMessage(messages.emailtooltip)}>
                    <span className="tooltip-trigger">
                      <InformationCircleIcon className="h-4 w-4" />
                    </span>
                  </Tooltip>
                </span>
              </label>
              <div className="mt-1 sm:col-span-2 sm:mb-2 sm:mt-0">
                <div className="flex rounded-md shadow-sm">
                  <Field
                    id="email"
                    name="email"
                    type="text"
                    placeholder={intl.formatMessage(messages.email)}
                    autoComplete="off"
                    data-form-type="other"
                    data-1pignore="true"
                    data-lpignore="true"
                    data-bwignore="true"
                  />
                </div>
                {errors.email && touched.email && (
                  <div className="error">{errors.email}</div>
                )}
              </div>
              <label htmlFor="username" className="text-label">
                {intl.formatMessage(messages.username)}
              </label>
              <div className="mb-2 mt-1 sm:col-span-2 sm:mt-0">
                <div className="flex rounded-md shadow-sm">
                  <Field
                    id="username"
                    name="username"
                    type="text"
                    placeholder={intl.formatMessage(messages.username)}
                    autoComplete="off"
                    data-form-type="other"
                    data-1pignore="true"
                    data-lpignore="true"
                    data-bwignore="true"
                  />
                </div>
                {errors.username && touched.username && (
                  <div className="error">{errors.username}</div>
                )}
              </div>
              <label htmlFor="password" className="text-label">
                {intl.formatMessage(messages.password)}
              </label>
              <div className="mb-2 mt-1 sm:col-span-2 sm:mt-0">
                <div className="flex rounded-md shadow-sm">
                  <Field
                    id="password"
                    name="password"
                    type="password"
                    placeholder={intl.formatMessage(messages.password)}
                    autoComplete="off"
                    data-form-type="other"
                    data-1pignore="true"
                    data-lpignore="true"
                    data-bwignore="true"
                  />
                </div>
                {errors.password && touched.password && (
                  <div className="error">{errors.password}</div>
                )}
              </div>
            </div>
            <div className="mt-8 border-t border-gray-700 pt-5">
              <div className="flex flex-row-reverse justify-between">
                <span className="inline-flex rounded-md shadow-sm">
                  <Button
                    buttonType="primary"
                    type="submit"
                    disabled={
                      isSubmitting || !isValid || !values.probeResult?.brand
                    }
                  >
                    {isSubmitting
                      ? intl.formatMessage(messages.signingin)
                      : intl.formatMessage(messages.signin)}
                  </Button>
                </span>
                {onCancel && (
                  <span className="inline-flex rounded-md shadow-sm">
                    <Button buttonType="default" onClick={() => onCancel()}>
                      <FormattedMessage {...messages.back} />
                    </Button>
                  </span>
                )}
              </div>
            </div>
          </Form>
        );
      }}
    </Formik>
  );
}

export default MediaServerSetup;
