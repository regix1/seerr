import PlexIcon from '@app/assets/services/plex.svg';
import Button from '@app/components/Common/Button';
import { SmallLoadingSpinner } from '@app/components/Common/LoadingSpinner';
import usePlexLogin from '@app/hooks/usePlexLogin';
import defineMessages from '@app/utils/defineMessages';
import { Fragment } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';

const messages = defineMessages('components.Login', {
  loginwithapp: 'Login with {appName}',
  loginWithPlex: 'Sign in with Plex',
});

interface PlexLoginButtonProps {
  onAuthToken: (authToken: string) => void;
  isProcessing?: boolean;
  onError?: (message: string) => void;
  large?: boolean;
}

const PlexLoginButton = ({
  onAuthToken,
  onError,
  isProcessing,
  large,
}: PlexLoginButtonProps) => {
  const intl = useIntl();
  const { loading, login } = usePlexLogin({ onAuthToken, onError });

  return (
    <Button
      className="relative flex-1 border-plex-500 bg-plex-500/30 hover:border-plex-500 hover:bg-plex-500/70 disabled:opacity-50"
      onClick={login}
      disabled={loading || isProcessing}
      aria-label={intl.formatMessage(messages.loginWithPlex)}
      data-testid="plex-login-button"
    >
      {loading && (
        <div className="absolute right-0 mr-4 h-4 w-4">
          <SmallLoadingSpinner />
        </div>
      )}

      {large ? (
        <FormattedMessage
          {...messages.loginwithapp}
          values={{
            appName: <PlexIcon className="ml-[0.35em] mt-[2px] w-8" />,
          }}
        >
          {(chunks) => (
            <>
              {chunks.map((c, index) =>
                typeof c === 'string' ? (
                  <span key={index}>{c}</span>
                ) : (
                  <Fragment key={index}>{c}</Fragment>
                )
              )}
            </>
          )}
        </FormattedMessage>
      ) : (
        <PlexIcon className="w-8" />
      )}
    </Button>
  );
};

export default PlexLoginButton;
