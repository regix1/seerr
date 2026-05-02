import SettingsEmby from '@app/components/Settings/SettingsEmby';
import SettingsLayout from '@app/components/Settings/SettingsLayout';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const EmbySettingsPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsEmby />
    </SettingsLayout>
  );
};

export default EmbySettingsPage;
