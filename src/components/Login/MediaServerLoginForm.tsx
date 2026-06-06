import Button from '@app/components/Common/Button';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import useSettings from '@app/hooks/useSettings';
import defineMessages from '@app/utils/defineMessages';
import { ArrowLeftOnRectangleIcon } from '@heroicons/react/24/outline';
import { ExclamationTriangleIcon } from '@heroicons/react/24/solid';
import { ApiErrorCode } from '@server/constants/error';
import axios from 'axios';
import { Field, Form, Formik } from 'formik';
import { useIntl } from 'react-intl';
import useToasts from '@app/hooks/useToasts';
import * as Yup from 'yup';

const messages = defineMessages('components.Login', {
  loginwithapp: 'Login with {appName}',
  username: 'Username',
  password: 'Password',
  validationusernamerequired: 'Username required',
  loginerror: 'Something went wrong while trying to sign in.',
  adminerror: 'You must use an admin account to sign in.',
  noadminerror: 'No admin user found on the server.',
  credentialerror: 'The username or password is incorrect.',
  invalidurlerror: 'Unable to connect to {mediaServerName} server.',
  tipUsernameHasTrailingWhitespace: 'The username ends with whitespace',
  signingin: 'Signing In…',
  signin: 'Sign In',
  forgotpassword: 'Forgot Password?',
  brandmismatch:
    'Detected as {detectedBrand} — signing in via {detectedBrand}.',
});

interface MediaServerLoginFormProps {
  provider: 'jellyfin' | 'emby';
  revalidate: () => void;
  inModal?: boolean;
  onSuccess?: () => void;
}

const MediaServerLoginForm: React.FC<MediaServerLoginFormProps> = ({
  provider,
  revalidate,
  inModal,
  onSuccess,
}) => {
  const toasts = useToasts();
  const intl = useIntl();
  const settings = useSettings();

  const appName = provider === 'jellyfin' ? 'Jellyfin' : 'Emby';
  const apiPath = `/api/v1/auth/${provider}`;

  const baseUrl =
    provider === 'jellyfin'
      ? settings.currentSettings.jellyfinExternalHost
      : settings.currentSettings.embyExternalHost;
  const forgotPasswordUrl =
    provider === 'jellyfin'
      ? settings.currentSettings.jellyfinForgotPasswordUrl
      : settings.currentSettings.embyForgotPasswordUrl;

  const LoginSchema = Yup.object().shape({
    username: Yup.string().required(
      intl.formatMessage(messages.validationusernamerequired)
    ),
    password: Yup.string(),
  });

  return (
    <div>
      <Formik
        initialValues={{ username: '', password: '' }}
        validationSchema={LoginSchema}
        validateOnBlur={false}
        onSubmit={async (values) => {
          let succeeded = false;
          const payload = {
            username: values.username,
            password: values.password,
            email: values.username,
          };
          try {
            try {
              await axios.post(apiPath, payload);
              succeeded = true;
            } catch (firstError) {
              const responseData = firstError?.response?.data as
                | {
                    errorCode?: string;
                    detectedBrand?: 'jellyfin' | 'emby';
                  }
                | undefined;
              if (
                firstError?.response?.status === 400 &&
                responseData?.errorCode === ApiErrorCode.ServerBrandMismatch &&
                responseData?.detectedBrand
              ) {
                const detectedBrand = responseData.detectedBrand;
                toasts.addToast(
                  intl.formatMessage(messages.brandmismatch, {
                    detectedBrand:
                      detectedBrand === 'emby' ? 'Emby' : 'Jellyfin',
                  }),
                  { autoDismiss: true, appearance: 'info' }
                );
                await axios.post(`/api/v1/auth/${detectedBrand}`, payload);
                succeeded = true;
              } else {
                throw firstError;
              }
            }
          } catch (e) {
            let errorMessage = messages.loginerror;
            switch (e?.response?.data?.message) {
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
            toasts.addToast(
              intl.formatMessage(errorMessage, {
                mediaServerName: appName,
              }),
              { autoDismiss: true, appearance: 'error' }
            );
          } finally {
            revalidate();
            if (succeeded) {
              onSuccess?.();
            }
          }
        }}
      >
        {({ errors, touched, values, isSubmitting, isValid }) => (
          <>
            <Form data-form-type="login">
              <div>
                {!inModal && (
                  <h2 className="-mt-1 mb-6 text-center text-lg font-bold text-neutral-200">
                    {intl.formatMessage(messages.loginwithapp, {
                      appName,
                    })}
                  </h2>
                )}

                <div className="mb-4 mt-1">
                  <div className="form-input-field">
                    <Field
                      id="username"
                      name="username"
                      type="text"
                      placeholder={intl.formatMessage(messages.username)}
                      className="!bg-gray-700/80 placeholder:text-gray-400"
                      data-form-type="username"
                    />
                  </div>
                  {touched.username && values.username.match(/\s$/) && (
                    <div className="warning label-tip flex items-center">
                      <ExclamationTriangleIcon className="mr-1 h-4 w-4" />
                      {intl.formatMessage(
                        messages.tipUsernameHasTrailingWhitespace
                      )}
                    </div>
                  )}
                  {errors.username && touched.username && (
                    <div className="error">{errors.username}</div>
                  )}
                </div>

                <div className="mb-2 mt-1">
                  <div className="form-input-field">
                    <SensitiveInput
                      as="field"
                      id="password"
                      name="password"
                      type="password"
                      autoComplete="current-password"
                      placeholder={intl.formatMessage(messages.password)}
                      className="!bg-gray-700/80 placeholder:text-gray-400"
                      data-form-type="password"
                      data-1pignore="false"
                      data-lpignore="false"
                    />
                  </div>
                  <div className="flex">
                    {errors.password && touched.password && (
                      <div className="error">{errors.password}</div>
                    )}
                    <div className="flex-grow" />
                    {baseUrl && (
                      <a
                        href={
                          forgotPasswordUrl
                            ? forgotPasswordUrl
                            : `${baseUrl}/web/index.html#!/forgotpassword.html`
                        }
                        target="_blank"
                        rel="noreferrer"
                        className="pt-2 text-sm text-indigo-500 hover:text-indigo-400"
                      >
                        {intl.formatMessage(messages.forgotpassword)}
                      </a>
                    )}
                  </div>
                </div>
              </div>

              <Button
                buttonType="primary"
                type="submit"
                disabled={isSubmitting || !isValid}
                className="mt-2 w-full shadow-sm"
              >
                <ArrowLeftOnRectangleIcon />
                <span>
                  {isSubmitting
                    ? intl.formatMessage(messages.signingin)
                    : intl.formatMessage(messages.signin)}
                </span>
              </Button>
            </Form>
          </>
        )}
      </Formik>
    </div>
  );
};

export default MediaServerLoginForm;
