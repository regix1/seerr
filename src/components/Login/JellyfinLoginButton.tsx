import EmbyIcon from '@app/assets/services/emby-icon-only.svg';
import JellyfinIcon from '@app/assets/services/jellyfin-icon.svg';
import Button from '@app/components/Common/Button';
import defineMessages from '@app/utils/defineMessages';
import { MediaServerType } from '@server/constants/server';
import { Fragment } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';

const messages = defineMessages('components.Login', {
  loginwithapp: 'Login with {appName}',
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
  const Icon = isEmby ? EmbyIcon : JellyfinIcon;
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
        <FormattedMessage
          {...messages.loginwithapp}
          values={{
            appName: <Icon className="ml-[0.35em] mt-[2px] w-8" />,
          }}
        >
          {(chunks) => (
            <>
              {chunks.map((chunk, index) =>
                typeof chunk === 'string' ? (
                  <span key={index}>{chunk}</span>
                ) : (
                  <Fragment key={index}>{chunk}</Fragment>
                )
              )}
            </>
          )}
        </FormattedMessage>
      ) : (
        <Icon className="w-8" />
      )}
    </Button>
  );
};

export default JellyfinLoginButton;
