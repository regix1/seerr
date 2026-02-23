import Badge from '@app/components/Common/Badge';
import Tooltip from '@app/components/Common/Tooltip';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Settings', {
  advancedTooltip:
    'Incorrectly configuring this setting may result in broken functionality',
  experimentalTooltip:
    'Enabling this setting may result in unexpected application behavior',
  restartrequiredTooltip:
    'Seerr must be restarted for changes to this setting to take effect',
});

const SettingsBadge = ({
  badgeType,
  className,
}: {
  badgeType: 'advanced' | 'experimental' | 'restartRequired';
  className?: string;
}) => {
  const intl = useIntl();

  const badgeClass = ['ml-1', className].filter(Boolean).join(' ');

  switch (badgeType) {
    case 'advanced':
      return (
        <Tooltip content={intl.formatMessage(messages.advancedTooltip)}>
          <Badge badgeType="danger" className={badgeClass}>
            {intl.formatMessage(globalMessages.advanced)}
          </Badge>
        </Tooltip>
      );
    case 'experimental':
      return (
        <Tooltip content={intl.formatMessage(messages.experimentalTooltip)}>
          <Badge badgeType="warning" className={badgeClass}>
            {intl.formatMessage(globalMessages.experimental)}
          </Badge>
        </Tooltip>
      );
    case 'restartRequired':
      return (
        <Tooltip content={intl.formatMessage(messages.restartrequiredTooltip)}>
          <Badge badgeType="primary" className={badgeClass}>
            {intl.formatMessage(globalMessages.restartRequired)}
          </Badge>
        </Tooltip>
      );
    default:
      return null;
  }
};

export default SettingsBadge;
