import Button from '@app/components/Common/Button';
import PlexLoginButton from '@app/components/Login/PlexLoginButton';
import MediaServerSetup from '@app/components/Setup/MediaServerSetup';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { MediaServerType } from '@server/constants/server';
import axios from 'axios';
import { useEffect, useState } from 'react';
import { FormattedMessage } from 'react-intl';

const messages = defineMessages('components.Setup', {
  welcome: 'Welcome to Seerr',
  signinMessage: 'Get started by signing in',
  signin: 'Sign in to your account',
  signinWithMediaServer: 'Enter your media server details',
  signinWithPlex: 'Enter your Plex details',
  back: 'Go back',
});

interface LoginWithMediaServerProps {
  serverType: MediaServerType;
  onCancel: () => void;
  onComplete: () => void;
  /** Called with the detected brand after a successful media-server login. */
  onDetected?: (detectedType: MediaServerType) => void;
}

const SetupLogin: React.FC<LoginWithMediaServerProps> = ({
  serverType,
  onCancel,
  onComplete,
  onDetected,
}) => {
  const [authToken, setAuthToken] = useState<string | undefined>(undefined);
  const [mediaServerType, setMediaServerType] = useState<MediaServerType>(
    MediaServerType.NOT_CONFIGURED
  );
  const { user, revalidate } = useUser();

  // Effect that is triggered when the `authToken` comes back from the Plex OAuth
  // We take the token and attempt to login. If we get a success message, we will
  // ask swr to revalidate the user which _shouid_ come back with a valid user.

  useEffect(() => {
    const login = async () => {
      try {
        const response = await axios.post('/api/v1/auth/plex', {
          authToken: authToken,
        });

        if (response.data?.id) {
          const { data: user } = await axios.get('/api/v1/auth/me');
          revalidate(user, false);
        }
      } catch {
        // auth failed silently and user can attempt again
      }
    };
    if (authToken && mediaServerType == MediaServerType.PLEX) {
      login();
    }
  }, [authToken, mediaServerType, revalidate]);

  useEffect(() => {
    if (user) {
      onComplete();
    }
  }, [user, mediaServerType, onComplete]);

  return (
    <div className="p-4">
      <div className="mb-2 flex justify-center text-xl font-bold">
        <FormattedMessage {...messages.signin} />
      </div>
      <div className="mb-2 flex justify-center pb-6 text-sm">
        {serverType === MediaServerType.PLEX ? (
          <FormattedMessage {...messages.signinWithPlex} />
        ) : (
          <FormattedMessage {...messages.signinWithMediaServer} />
        )}
      </div>
      {serverType === MediaServerType.PLEX && (
        <>
          <div className="flex justify-center bg-black/30 px-10 py-8">
            <PlexLoginButton
              large
              onAuthToken={(authToken) => {
                setMediaServerType(MediaServerType.PLEX);
                setAuthToken(authToken);
              }}
            />
          </div>
          <div className="mt-4">
            <Button buttonType="default" onClick={() => onCancel()}>
              <FormattedMessage {...messages.back} />
            </Button>
          </div>
        </>
      )}
      {serverType !== MediaServerType.PLEX && (
        <MediaServerSetup
          revalidate={revalidate}
          onCancel={onCancel}
          onDetected={onDetected}
        />
      )}
    </div>
  );
};

export default SetupLogin;
