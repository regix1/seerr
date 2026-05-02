import EmbyWordmark from '@app/assets/services/emby.svg';
import Button from '@app/components/Common/Button';
import defineMessages from '@app/utils/defineMessages';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Login', {
  signinWithEmby: 'Sign in with Emby',
});

interface EmbyLoginButtonProps {
  onClick: () => void;
  large?: boolean;
  disabled?: boolean;
}

const EmbyLoginButton = ({
  onClick,
  large,
  disabled,
}: EmbyLoginButtonProps) => {
  const intl = useIntl();
  const ariaLabel = intl.formatMessage(messages.signinWithEmby);

  return (
    <Button
      className="relative flex-1 border-emby-500 bg-emby-500/30 hover:border-emby-500 hover:bg-emby-500/70 disabled:opacity-50"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      data-testid="emby-login-button"
    >
      {large ? (
        <span className="flex items-center justify-center">
          <EmbyWordmark className="mr-2 h-5 shrink-0" />
          <span>{ariaLabel}</span>
        </span>
      ) : (
        <EmbyWordmark className="h-5" />
      )}
    </Button>
  );
};

export default EmbyLoginButton;
