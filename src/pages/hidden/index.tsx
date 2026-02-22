import HiddenMedia from '@app/components/HiddenMedia';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@server/lib/permissions';
import type { NextPage } from 'next';

const HiddenMediaPage: NextPage = () => {
  useRouteGuard(Permission.MANAGE_REQUESTS);
  return <HiddenMedia />;
};

export default HiddenMediaPage;
