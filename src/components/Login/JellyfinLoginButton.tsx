import EmbyWordmark from '@app/assets/services/emby.svg';
import JellyfinWordmark from '@app/assets/services/jellyfin.svg';
import Button from '@app/components/Common/Button';
import defineMessages from '@app/utils/defineMessages';
import { MediaServerType } from '@server/constants/server';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Login', {
  signinWithJellyfin: 'Sign in with Jellyfin',
  signinWithEmby: 'Sign in with Emby',
});

interface JellyfinLoginButtonProps {
  serverType: MediaServerType;
  onClick: () => void;
  large?: boolean;
  disabled?: boolean;
}

const JellyfinLoginButton = ({
  serverType,
  onClick,
  large,
  disabled,
}: JellyfinLoginButtonProps) => {
  const intl = useIntl();
  const isEmby = serverType === MediaServerType.EMBY;
  const Wordmark = isEmby ? EmbyWordmark : JellyfinWordmark;
  const colorClasses = isEmby
    ? 'border-emby-500 bg-emby-500/30 hover:border-emby-500 hover:bg-emby-500/70'
    : 'border-jellyfin-500 bg-jellyfin-500/30 hover:border-jellyfin-500 hover:bg-jellyfin-500/70';
  const ariaLabel = isEmby
    ? intl.formatMessage(messages.signinWithEmby)
    : intl.formatMessage(messages.signinWithJellyfin);

  return (
    <Button
      className={`relative flex-1 ${colorClasses} disabled:opacity-50`}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      data-testid="jellyfin-login-button"
    >
      {large ? (
        <span className="flex items-center justify-center">
          <Wordmark className="mr-2 h-5 shrink-0" />
          <span>{ariaLabel}</span>
        </span>
      ) : (
        <Wordmark className="h-5" />
      )}
    </Button>
  );
};

export default JellyfinLoginButton;
