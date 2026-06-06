import ImageFader from '@app/components/Common/ImageFader';
import Modal from '@app/components/Common/Modal';
import PageTitle from '@app/components/Common/PageTitle';
import LanguagePicker from '@app/components/Layout/LanguagePicker';
import EmbyLoginButton from '@app/components/Login/EmbyLoginButton';
import JellyfinLoginButton from '@app/components/Login/JellyfinLoginButton';
import LocalLogin from '@app/components/Login/LocalLogin';
import MediaServerLoginForm from '@app/components/Login/MediaServerLoginForm';
import PlexLoginButton from '@app/components/Login/PlexLoginButton';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { XCircleIcon } from '@heroicons/react/24/solid';
import axios from 'axios';
import { useRouter } from 'next/dist/client/router';
import Image from 'next/image';
import { Fragment, useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Login', {
  signin: 'Sign In',
  signinheader: 'Sign in to continue',
  signinwithplex: 'Use your Plex account',
  signinwithoverseerr: 'Use your {applicationTitle} account',
  orsigninwith: 'Or sign in with',
  signinWithJellyfin: 'Sign in with Jellyfin',
  signinWithEmby: 'Sign in with Emby',
});

const Login = () => {
  const intl = useIntl();
  const router = useRouter();
  const settings = useSettings();
  const { user, revalidate } = useUser();

  const [error, setError] = useState('');
  const [isProcessing, setProcessing] = useState(false);
  const [authToken, setAuthToken] = useState<string | undefined>(undefined);
  const [showJellyfinModal, setShowJellyfinModal] = useState(false);
  const [showEmbyModal, setShowEmbyModal] = useState(false);

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
    embyLoginEnabled,
    localLogin,
  } = settings.currentSettings;

  // At least one media-server login button is available
  const hasMediaServerLogin =
    plexLoginEnabled || jellyfinLoginEnabled || embyLoginEnabled;

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

              {/* Brand login buttons — stacked vertically on mobile, side-by-side on lg+.
                  Order: Plex → Jellyfin → Emby */}
              {hasMediaServerLogin && (
                <div className="flex w-full flex-col gap-3 lg:flex-row lg:gap-3">
                  {plexLoginEnabled && (
                    <div className="flex flex-1">
                      <PlexLoginButton
                        isProcessing={isProcessing}
                        onAuthToken={(authToken: string) =>
                          setAuthToken(authToken)
                        }
                        large
                      />
                    </div>
                  )}
                  {jellyfinLoginEnabled && (
                    <div className="flex flex-1">
                      <JellyfinLoginButton
                        onClick={() => setShowJellyfinModal(true)}
                        disabled={isProcessing}
                        large
                      />
                    </div>
                  )}
                  {embyLoginEnabled && (
                    <div className="flex flex-1">
                      <EmbyLoginButton
                        onClick={() => setShowEmbyModal(true)}
                        disabled={isProcessing}
                        large
                      />
                    </div>
                  )}
                </div>
              )}

              {/* Jellyfin login modal */}
              <Transition
                as={Fragment}
                show={showJellyfinModal}
                enter="transition-opacity duration-300"
                enterFrom="opacity-0"
                enterTo="opacity-100"
                leave="transition-opacity duration-300"
                leaveFrom="opacity-100"
                leaveTo="opacity-0"
              >
                <Modal
                  title={intl.formatMessage(messages.signinWithJellyfin)}
                  onCancel={() => setShowJellyfinModal(false)}
                  backgroundClickable
                  dialogClass="max-w-sm"
                >
                  <MediaServerLoginForm
                    provider="jellyfin"
                    revalidate={revalidate}
                    inModal
                    onSuccess={() => setShowJellyfinModal(false)}
                  />
                </Modal>
              </Transition>

              {/* Emby login modal */}
              <Transition
                as={Fragment}
                show={showEmbyModal}
                enter="transition-opacity duration-300"
                enterFrom="opacity-0"
                enterTo="opacity-100"
                leave="transition-opacity duration-300"
                leaveFrom="opacity-100"
                leaveTo="opacity-0"
              >
                <Modal
                  title={intl.formatMessage(messages.signinWithEmby)}
                  onCancel={() => setShowEmbyModal(false)}
                  backgroundClickable
                  dialogClass="max-w-sm"
                >
                  <MediaServerLoginForm
                    provider="emby"
                    revalidate={revalidate}
                    inModal
                    onSuccess={() => setShowEmbyModal(false)}
                  />
                </Modal>
              </Transition>

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
