import EmbyIcon from '@app/assets/services/emby-icon-only.svg';
import JellyfinIcon from '@app/assets/services/jellyfin-icon.svg';
import ImageFader from '@app/components/Common/ImageFader';
import PageTitle from '@app/components/Common/PageTitle';
import LanguagePicker from '@app/components/Layout/LanguagePicker';
import JellyfinLogin from '@app/components/Login/JellyfinLogin';
import LocalLogin from '@app/components/Login/LocalLogin';
import PlexLoginButton from '@app/components/Login/PlexLoginButton';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { XCircleIcon } from '@heroicons/react/24/solid';
import { MediaServerType } from '@server/constants/server';
import axios from 'axios';
import { useRouter } from 'next/dist/client/router';
import Image from 'next/image';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Login', {
  signin: 'Sign In',
  signinheader: 'Sign in to continue',
  signinwithplex: 'Use your Plex account',
  signinwithjellyfin: 'Use your {mediaServerName} account',
  signinwithoverseerr: 'Use your {applicationTitle} account',
  orsigninwith: 'Or sign in with',
});

const Login = () => {
  const intl = useIntl();
  const router = useRouter();
  const settings = useSettings();
  const { user, revalidate } = useUser();

  const [error, setError] = useState('');
  const [isProcessing, setProcessing] = useState(false);
  const [authToken, setAuthToken] = useState<string | undefined>(undefined);

  // Effect that is triggered when the `authToken` comes back from the Plex OAuth
  // We take the token and attempt to sign in. If we get a success message, we will
  // ask swr to revalidate the user which _should_ come back with a valid user.
  useEffect(() => {
    const login = async () => {
      setProcessing(true);
      try {
        const response = await axios.post('/api/v1/auth/plex', { authToken });

        if (response.data?.id) {
          revalidate();
        }
      } catch (e) {
        setError(e.response?.data?.message);
        setAuthToken(undefined);
        setProcessing(false);
      }
    };
    if (authToken) {
      login();
    }
  }, [authToken, revalidate]);

  // Effect that is triggered whenever `useUser`'s user changes. If we get a new
  // valid user, we redirect the user to the home page as the login was successful.
  useEffect(() => {
    if (user) {
      router.push('/');
    }
  }, [user, router]);

  const { data: backdrops } = useSWR<string[]>('/api/v1/backdrops', {
    refreshInterval: 0,
    refreshWhenHidden: false,
    revalidateOnFocus: false,
  });

  const {
    plexLoginEnabled,
    jellyfinLoginEnabled,
    localLogin,
    mediaServerType,
  } = settings.currentSettings;

  // Dual mode: both providers are active — colored box differentiates Jellyfin from Plex.
  // Color matches the active media server's brand (Jellyfin purple #AA5CC3 vs Emby green).
  const isDualMode = plexLoginEnabled && jellyfinLoginEnabled;
  const jfBoxClasses =
    mediaServerType === MediaServerType.JELLYFIN
      ? 'mb-4 rounded-md border border-[#AA5CC3]/60 bg-[#AA5CC3]/10 p-4'
      : 'mb-4 rounded-md border border-green-500/60 bg-green-500/10 p-4';

  // At least one media-server login is available
  const hasMediaServerLogin = plexLoginEnabled || jellyfinLoginEnabled;

  // Show the "Or sign in with" divider when a form is rendered above local login
  const loginFormVisible = hasMediaServerLogin || localLogin;

  return (
    <div className="relative flex min-h-screen flex-col bg-gray-900 py-8 sm:py-14">
      <PageTitle title={intl.formatMessage(messages.signin)} />
      <ImageFader
        backgroundImages={
          backdrops?.map(
            (backdrop) => `https://image.tmdb.org/t/p/original${backdrop}`
          ) ?? []
        }
      />
      <div className="absolute right-4 top-4 z-50">
        <LanguagePicker />
      </div>
      <div className="relative z-40 mt-10 flex flex-col items-center px-4 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="relative h-48 w-full max-w-full">
          <Image src="/logo_stacked.svg" alt="Logo" fill />
        </div>
      </div>
      <div className="relative z-50 mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div
          className="bg-gray-800/50 shadow sm:rounded-lg"
          style={{ backdropFilter: 'blur(5px)' }}
        >
          <>
            {/* Error banner — always pinned at top */}
            <Transition
              as="div"
              show={!!error}
              enter="transition-opacity duration-300"
              enterFrom="opacity-0"
              enterTo="opacity-100"
              leave="transition-opacity duration-300"
              leaveFrom="opacity-100"
              leaveTo="opacity-0"
            >
              <div className="mb-4 rounded-md bg-red-600 p-4">
                <div className="flex">
                  <div className="flex-shrink-0">
                    <XCircleIcon className="h-5 w-5 text-red-300" />
                  </div>
                  <div className="ml-3">
                    <h3 className="text-sm font-medium text-red-300">
                      {error}
                    </h3>
                  </div>
                </div>
              </div>
            </Transition>

            <div className="px-10 py-8">
              {/* Page heading — only when no login form at all */}
              {!loginFormVisible && (
                <h2 className="mb-6 text-center text-lg font-bold text-neutral-200">
                  {intl.formatMessage(messages.signinheader)}
                </h2>
              )}

              {/* Jellyfin / Emby form
                  - Dual mode: wrapped in green container (visual differentiator)
                  - Single-provider mode: rendered plain inside the existing card */}
              {jellyfinLoginEnabled &&
                (isDualMode ? (
                  <div className={jfBoxClasses}>
                    <JellyfinLogin
                      serverType={mediaServerType}
                      revalidate={revalidate}
                    />
                  </div>
                ) : (
                  <>
                    {mediaServerType === MediaServerType.JELLYFIN ? (
                      <JellyfinIcon className="mx-auto mb-4 h-8" />
                    ) : (
                      <EmbyIcon className="mx-auto mb-4 h-8" />
                    )}
                    <JellyfinLogin
                      serverType={mediaServerType}
                      revalidate={revalidate}
                    />
                  </>
                ))}

              {/* Plex login button — full width, below the Jellyfin green box.
                  Wrapped in flex container so PlexLoginButton's flex-1 expands
                  to full width, and adds vertical spacing when JF form precedes. */}
              {plexLoginEnabled && (
                <div
                  className={`flex w-full ${
                    jellyfinLoginEnabled ? 'mt-3' : ''
                  }`}
                >
                  <PlexLoginButton
                    isProcessing={isProcessing}
                    onAuthToken={(authToken) => setAuthToken(authToken)}
                    large
                  />
                </div>
              )}

              {/* "Or sign in with" divider — only when local login is enabled
                  AND at least one media-server form is already rendered above */}
              {localLogin && hasMediaServerLogin && (
                <div className="flex items-center py-5">
                  <div className="flex-grow border-t border-gray-600" />
                  <span className="mx-2 flex-shrink text-sm text-gray-400">
                    {intl.formatMessage(messages.orsigninwith)}
                  </span>
                  <div className="flex-grow border-t border-gray-600" />
                </div>
              )}

              {/* Local login form */}
              {localLogin && <LocalLogin revalidate={revalidate} />}
            </div>
          </>
        </div>
      </div>
    </div>
  );
};

export default Login;
