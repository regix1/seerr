import Button from '@app/components/Common/Button';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import { isValidURL } from '@app/utils/urlValidationHelper';
import { ArrowDownOnSquareIcon } from '@heroicons/react/24/outline';
import { Field, Formik } from 'formik';
import * as Yup from 'yup';

export interface MediaBrowserSettingsFormValues {
  hostname?: string;
  port: number | string;
  useSsl?: boolean;
  urlBase?: string;
  externalUrl?: string;
  forgotPasswordUrl?: string;
  apiKey?: string;
}

interface MediaBrowserSettings {
  ip?: string;
  port?: number;
  useSsl?: boolean;
  urlBase?: string;
  externalHostname?: string;
  forgotPasswordUrl?: string;
  apiKey?: string;
}

interface MediaBrowserSettingsFormProps {
  settings?: MediaBrowserSettings;
  isSetupSettings?: boolean;
  onSubmit: (values: MediaBrowserSettingsFormValues) => Promise<void>;
  labels: {
    hostname: string;
    port: string;
    enableSsl: string;
    apiKey: string;
    urlBase: string;
    externalUrl: string;
    forgotPasswordUrl: string;
    save: string;
    saving: string;
  };
  validationMessages: {
    hostnameRequired: string;
    portRequired: string;
    url: string;
    urlTrailingSlash: string;
    urlBaseLeadingSlash: string;
    urlBaseTrailingSlash: string;
  };
}

const MediaBrowserSettingsForm = ({
  settings,
  isSetupSettings = false,
  onSubmit,
  labels,
  validationMessages,
}: MediaBrowserSettingsFormProps) => {
  const validationSchema = Yup.object().shape({
    hostname: Yup.string()
      .nullable()
      .required(validationMessages.hostnameRequired),
    port: Yup.number().when(['hostname'], {
      is: (value: unknown) => !!value,
      then: (schema) =>
        schema
          .typeError(validationMessages.portRequired)
          .nullable()
          .required(validationMessages.portRequired),
      otherwise: (schema) =>
        schema.typeError(validationMessages.portRequired).nullable(),
    }),
    urlBase: Yup.string()
      .test(
        'leading-slash',
        validationMessages.urlBaseLeadingSlash,
        (value) => !value || value.startsWith('/')
      )
      .test(
        'trailing-slash',
        validationMessages.urlBaseTrailingSlash,
        (value) => !value || !value.endsWith('/')
      ),
    externalUrl: Yup.string()
      .nullable()
      .test('valid-url', validationMessages.url, isValidURL)
      .test(
        'no-trailing-slash',
        validationMessages.urlTrailingSlash,
        (value) => !value || !value.endsWith('/')
      ),
    forgotPasswordUrl: Yup.string()
      .nullable()
      .test('valid-url', validationMessages.url, isValidURL)
      .test(
        'no-trailing-slash',
        validationMessages.urlTrailingSlash,
        (value) => !value || !value.endsWith('/')
      ),
  });

  return (
    <Formik<MediaBrowserSettingsFormValues>
      initialValues={{
        hostname: settings?.ip,
        port: settings?.port ?? 8096,
        useSsl: settings?.useSsl,
        urlBase: settings?.urlBase || '',
        externalUrl: settings?.externalHostname || '',
        forgotPasswordUrl: settings?.forgotPasswordUrl || '',
        apiKey: settings?.apiKey,
      }}
      validationSchema={validationSchema}
      onSubmit={onSubmit}
    >
      {({
        errors,
        touched,
        values,
        setFieldValue,
        handleSubmit,
        isSubmitting,
        isValid,
      }) => (
        <form className="section" onSubmit={handleSubmit}>
          {!isSetupSettings && (
            <>
              <div className="form-row">
                <label htmlFor="hostname" className="text-label">
                  {labels.hostname}
                  <span className="text-red-500">*</span>
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <span className="inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-gray-100 sm:text-sm">
                      {values.useSsl ? 'https://' : 'http://'}
                    </span>
                    <Field
                      type="text"
                      inputMode="url"
                      id="hostname"
                      name="hostname"
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
                  {labels.port}
                  <span className="label-required">*</span>
                </label>
                <div className="form-input-area">
                  <Field
                    type="text"
                    inputMode="numeric"
                    id="port"
                    name="port"
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
                  {labels.enableSsl}
                </label>
                <div className="form-input-area">
                  <Field
                    type="checkbox"
                    id="useSsl"
                    name="useSsl"
                    onChange={() => {
                      setFieldValue('useSsl', !values.useSsl);
                      setFieldValue('port', values.useSsl ? 8096 : 443);
                    }}
                  />
                </div>
              </div>
            </>
          )}
          <div className="form-row">
            <label htmlFor="apiKey" className="text-label">
              {labels.apiKey}
            </label>
            <div className="form-input-area">
              <div className="form-input-field">
                <SensitiveInput
                  as="field"
                  type="text"
                  inputMode="url"
                  id="apiKey"
                  name="apiKey"
                />
              </div>
              {errors.apiKey && touched.apiKey && (
                <div className="error">{errors.apiKey}</div>
              )}
            </div>
          </div>
          {!isSetupSettings && (
            <div className="form-row">
              <label htmlFor="urlBase" className="text-label">
                {labels.urlBase}
              </label>
              <div className="form-input-area">
                <div className="form-input-field">
                  <Field
                    type="text"
                    inputMode="url"
                    id="urlBase"
                    name="urlBase"
                  />
                </div>
                {errors.urlBase &&
                  touched.urlBase &&
                  typeof errors.urlBase === 'string' && (
                    <div className="error">{errors.urlBase}</div>
                  )}
              </div>
            </div>
          )}
          <div className="form-row">
            <label htmlFor="externalUrl" className="text-label">
              {labels.externalUrl}
            </label>
            <div className="form-input-area">
              <div className="form-input-field">
                <Field
                  type="text"
                  inputMode="url"
                  id="externalUrl"
                  name="externalUrl"
                />
              </div>
              {errors.externalUrl && touched.externalUrl && (
                <div className="error">{errors.externalUrl}</div>
              )}
            </div>
          </div>
          <div className="form-row">
            <label htmlFor="forgotPasswordUrl" className="text-label">
              {labels.forgotPasswordUrl}
            </label>
            <div className="form-input-area">
              <div className="form-input-field">
                <Field
                  type="text"
                  inputMode="url"
                  id="forgotPasswordUrl"
                  name="forgotPasswordUrl"
                />
              </div>
              {errors.forgotPasswordUrl && touched.forgotPasswordUrl && (
                <div className="error">{errors.forgotPasswordUrl}</div>
              )}
            </div>
          </div>
          <div className={`actions ${isSetupSettings ? 'mt-0 border-0' : ''}`}>
            <div className="flex justify-end">
              <span className="ml-3 inline-flex rounded-md shadow-sm">
                <Button
                  buttonType="primary"
                  type="submit"
                  disabled={isSubmitting || !isValid}
                >
                  <ArrowDownOnSquareIcon />
                  <span>{isSubmitting ? labels.saving : labels.save}</span>
                </Button>
              </span>
            </div>
          </div>
        </form>
      )}
    </Formik>
  );
};

export default MediaBrowserSettingsForm;
