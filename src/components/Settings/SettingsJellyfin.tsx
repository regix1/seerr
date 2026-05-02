import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import ManualScanPanel from '@app/components/Settings/ManualScanPanel';
import MediaBrowserSettingsForm from '@app/components/Settings/MediaBrowserSettingsForm';
import MediaServerLibrariesPanel from '@app/components/Settings/MediaServerLibrariesPanel';
import useMediaServerSettings from '@app/hooks/useMediaServerSettings';
import useScanCompleteToast from '@app/hooks/useScanCompleteToast';
import useSettings from '@app/hooks/useSettings';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { ApiErrorCode } from '@server/constants/error';
import type { JellyfinSettings } from '@server/lib/settings';
import axios from 'axios';
import { FormattedMessage, useIntl } from 'react-intl';
import { useToasts } from 'react-toast-notifications';

const messages = defineMessages('components.Settings', {
  jellyfinsettings: '{mediaServerName} Settings',
  jellyfinsettingsDescription:
    'Configure the settings for your {mediaServerName} server. {mediaServerName} scans your {mediaServerName} libraries to see what content is available.',
  timeout: 'Timeout',
  save: 'Save Changes',
  saving: 'Saving…',
  jellyfinlibraries: '{mediaServerName} Libraries',
  jellyfinlibrariesDescription:
    'The libraries {mediaServerName} scans for titles. Click the button below if no libraries are listed.',
  jellyfinSettingsFailure:
    'Something went wrong while saving {mediaServerName} settings.',
  jellyfinSettingsSuccess: '{mediaServerName} settings saved successfully!',
  jellyfinSettings: '{mediaServerName} Settings',
  jellyfinSettingsDescription:
    'Optionally configure the internal and external endpoints for your {mediaServerName} server. In most cases, the external URL is different to the internal URL. A custom password reset URL can also be set for {mediaServerName} login, in case you would like to redirect to a different password reset page. You can also change the Jellyfin API key, which was automatically generated previously.',
  externalUrl: 'External URL',
  hostname: 'Hostname or IP Address',
  port: 'Port',
  enablessl: 'Use SSL',
  urlBase: 'URL Base',
  jellyfinForgotPasswordUrl: 'Forgot Password URL',
  apiKey: 'API key',
  jellyfinSyncFailedNoLibrariesFound: 'No libraries were found',
  jellyfinSyncFailedAutomaticGroupedFolders:
    'Custom authentication with Automatic Library Grouping not supported',
  jellyfinSyncFailedGenericError:
    'Something went wrong while syncing libraries',
  invalidurlerror: 'Unable to connect to {mediaServerName} server.',
  syncing: 'Syncing',
  syncJellyfin: 'Sync Libraries',
  manualscanJellyfin: 'Manual Library Scan',
  manualscanDescriptionJellyfin:
    "Normally, this will only be run once every 24 hours. Seerr will check your {mediaServerName} server's recently added more aggressively. If this is your first time configuring Seerr, a one-time full manual library scan is recommended!",
  notrunning: 'Not Running',
  currentlibrary: 'Current Library: {name}',
  librariesRemaining: 'Libraries Remaining: {count}',
  startscan: 'Start Scan',
  cancelscan: 'Cancel Scan',
  validationUrl: 'You must provide a valid URL',
  validationHostnameRequired: 'You must provide a valid hostname or IP address',
  validationPortRequired: 'You must provide a valid port number',
  validationUrlTrailingSlash: 'URL must not end in a trailing slash',
  validationUrlBaseLeadingSlash: 'URL base must have a leading slash',
  validationUrlBaseTrailingSlash: 'URL base must not end in a trailing slash',
  tip: 'Tip',
  scanbackground:
    'Scanning will run in the background. You can continue the setup process in the meantime.',
  bothProvidersBanner:
    'Libraries from Plex and {server} are scanned independently. Items present on both servers are deduplicated by TMDB ID.',
});

interface SettingsJellyfinProps {
  isSetupSettings?: boolean;
  onComplete?: () => void;
}

const SettingsJellyfin: React.FC<SettingsJellyfinProps> = ({
  onComplete,
  isSetupSettings,
}) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const settings = useSettings();
  const handleLibrarySyncError = (error: unknown) => {
    const message = axios.isAxiosError(error)
      ? error.response?.data?.message
      : undefined;

    if (message === ApiErrorCode.SyncErrorGroupedFolders) {
      addToast(
        intl.formatMessage(messages.jellyfinSyncFailedAutomaticGroupedFolders),
        {
          autoDismiss: true,
          appearance: 'warning',
        }
      );
    } else if (message === ApiErrorCode.SyncErrorNoLibraries) {
      addToast(
        intl.formatMessage(messages.jellyfinSyncFailedNoLibrariesFound),
        {
          autoDismiss: true,
          appearance: 'error',
        }
      );
    } else {
      addToast(intl.formatMessage(messages.jellyfinSyncFailedGenericError), {
        autoDismiss: true,
        appearance: 'error',
      });
    }
  };

  const {
    data,
    error,
    mutate: revalidate,
    syncData: dataSync,
    isSyncing,
    syncLibraries,
    toggleLibrary,
    startScan,
    cancelScan,
  } = useMediaServerSettings({
    provider: 'jellyfin',
    onLibrarySyncError: handleLibrarySyncError,
  });

  useScanCompleteToast('Jellyfin', dataSync);

  const showBothProvidersBanner =
    settings.currentSettings.plexLoginEnabled &&
    settings.currentSettings.jellyfinLoginEnabled;

  const activeLibraries =
    data?.libraries
      .filter((library) => library.enabled)
      .map((library) => library.id) ?? [];

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  const mediaServerFormatValues = {
    mediaServerName: 'Jellyfin',
  };

  const serverLabel = 'Jellyfin';

  return (
    <>
      {showBothProvidersBanner && (
        <div className="section">
          <Alert
            title={intl.formatMessage(messages.bothProvidersBanner, {
              server: serverLabel,
            })}
            type="info"
          />
        </div>
      )}
      <div className="mb-6 mt-10">
        <h3 className="heading">
          {intl.formatMessage(
            messages.jellyfinSettings,
            mediaServerFormatValues
          )}
        </h3>
        <p className="description">
          {intl.formatMessage(
            messages.jellyfinSettingsDescription,
            mediaServerFormatValues
          )}
        </p>
      </div>
      <MediaBrowserSettingsForm
        settings={{
          ip: data?.ip,
          port: data?.port,
          useSsl: data?.useSsl,
          urlBase: data?.urlBase,
          externalHostname: data?.externalHostname,
          forgotPasswordUrl: data?.jellyfinForgotPasswordUrl,
          apiKey: data?.apiKey,
        }}
        isSetupSettings={isSetupSettings}
        labels={{
          hostname: intl.formatMessage(messages.hostname),
          port: intl.formatMessage(messages.port),
          enableSsl: intl.formatMessage(messages.enablessl),
          apiKey: intl.formatMessage(messages.apiKey),
          urlBase: intl.formatMessage(messages.urlBase),
          externalUrl: intl.formatMessage(messages.externalUrl),
          forgotPasswordUrl: intl.formatMessage(
            messages.jellyfinForgotPasswordUrl
          ),
          save: intl.formatMessage(globalMessages.save),
          saving: intl.formatMessage(globalMessages.saving),
        }}
        validationMessages={{
          hostnameRequired: intl.formatMessage(
            messages.validationHostnameRequired
          ),
          portRequired: intl.formatMessage(messages.validationPortRequired),
          url: intl.formatMessage(messages.validationUrl),
          urlTrailingSlash: intl.formatMessage(
            messages.validationUrlTrailingSlash
          ),
          urlBaseLeadingSlash: intl.formatMessage(
            messages.validationUrlBaseLeadingSlash
          ),
          urlBaseTrailingSlash: intl.formatMessage(
            messages.validationUrlBaseTrailingSlash
          ),
        }}
        onSubmit={async (values) => {
          try {
            await axios.post('/api/v1/settings/jellyfin', {
              ip: values.hostname,
              port: Number(values.port),
              useSsl: values.useSsl,
              urlBase: values.urlBase,
              externalHostname: values.externalUrl,
              jellyfinForgotPasswordUrl: values.forgotPasswordUrl,
              apiKey: values.apiKey,
            } as JellyfinSettings);

            addToast(
              intl.formatMessage(
                messages.jellyfinSettingsSuccess,
                mediaServerFormatValues
              ),
              {
                autoDismiss: true,
                appearance: 'success',
              }
            );
          } catch (error) {
            const message = axios.isAxiosError(error)
              ? error.response?.data?.message
              : undefined;

            if (message === ApiErrorCode.InvalidUrl) {
              addToast(
                intl.formatMessage(
                  messages.invalidurlerror,
                  mediaServerFormatValues
                ),
                {
                  autoDismiss: true,
                  appearance: 'error',
                }
              );
            } else {
              addToast(
                intl.formatMessage(
                  messages.jellyfinSettingsFailure,
                  mediaServerFormatValues
                ),
                {
                  autoDismiss: true,
                  appearance: 'error',
                }
              );
            }
          } finally {
            revalidate();
          }
        }}
      />
      <MediaServerLibrariesPanel
        title={intl.formatMessage(
          messages.jellyfinlibraries,
          mediaServerFormatValues
        )}
        description={intl.formatMessage(
          messages.jellyfinlibrariesDescription,
          mediaServerFormatValues
        )}
        libraries={data?.libraries}
        isSyncing={isSyncing}
        syncDisabled={isSyncing}
        syncLabel={intl.formatMessage(messages.syncJellyfin)}
        syncingLabel={intl.formatMessage(messages.syncing)}
        keyPrefix="setting-library"
        onSync={() => syncLibraries(activeLibraries)}
        onToggle={(libraryId) =>
          toggleLibrary(libraryId, activeLibraries, onComplete)
        }
      />
      <div className="mb-6 mt-10">
        <h3 className="heading">
          <FormattedMessage {...messages.manualscanJellyfin} />
        </h3>
        <p className="description">
          {intl.formatMessage(
            messages.manualscanDescriptionJellyfin,
            mediaServerFormatValues
          )}
        </p>
      </div>
      <ManualScanPanel
        syncStatus={dataSync}
        onStart={startScan}
        onCancel={cancelScan}
        labels={{
          notRunning: intl.formatMessage(messages.notrunning),
          startScan: intl.formatMessage(messages.startscan),
          cancelScan: intl.formatMessage(messages.cancelscan),
          currentLibrary: (name) =>
            intl.formatMessage(messages.currentlibrary, { name }),
          librariesRemaining: (count) =>
            intl.formatMessage(messages.librariesRemaining, { count }),
        }}
      />
      {isSetupSettings && (
        <div className="text-sm text-gray-500">
          <span className="mr-2">
            <Badge>{intl.formatMessage(messages.tip)}</Badge>
          </span>
          {intl.formatMessage(messages.scanbackground)}
        </div>
      )}
    </>
  );
};

export default SettingsJellyfin;
