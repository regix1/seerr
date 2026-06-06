import SettingsFileFlows from '@app/components/Settings/SettingsFileFlows';
import SettingsLayout from '@app/components/Settings/SettingsLayout';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const FileFlowsSettingsPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsFileFlows />
    </SettingsLayout>
  );
};

export default FileFlowsSettingsPage;
