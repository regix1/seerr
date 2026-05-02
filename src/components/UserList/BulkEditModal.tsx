import Modal from '@app/components/Common/Modal';
import PermissionEdit from '@app/components/PermissionEdit';
import type { User } from '@app/hooks/useUser';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { hasPermission } from '@server/lib/permissions';
import axios from 'axios';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import { useToasts } from 'react-toast-notifications';

interface BulkEditProps {
  selectedUserIds: number[];
  users?: User[];
  onCancel?: () => void;
  onComplete?: (updatedUsers: User[]) => void;
  onSaving?: (isSaving: boolean) => void;
}

interface BulkPermissionState {
  permissions: number;
  permissions2: number;
}

const messages = defineMessages('components.UserList', {
  userssaved: 'User permissions saved successfully!',
  userfail: 'Something went wrong while saving user permissions.',
  edituser: 'Edit User Permissions',
});

const BulkEditModal = ({
  selectedUserIds,
  users,
  onCancel,
  onComplete,
  onSaving,
}: BulkEditProps) => {
  const { user: currentUser } = useUser();
  const intl = useIntl();
  const { addToast } = useToasts();
  const [permissionState, setPermissionState] = useState<BulkPermissionState>({
    permissions: 0,
    permissions2: 0,
  });
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (onSaving) {
      onSaving(isSaving);
    }
  }, [isSaving, onSaving]);

  const updateUsers = async () => {
    try {
      setIsSaving(true);
      const { data: updated } = await axios.put<User[]>(`/api/v1/user`, {
        ids: selectedUserIds,
        permissions: permissionState.permissions,
        permissions2: permissionState.permissions2,
      });
      if (onComplete) {
        onComplete(updated);
      }
      addToast(intl.formatMessage(messages.userssaved), {
        appearance: 'success',
        autoDismiss: true,
      });
    } catch {
      addToast(intl.formatMessage(messages.userfail), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsSaving(false);
    }
  };

  useEffect(() => {
    if (users) {
      const selectedUsers = users.filter((u) => selectedUserIds.includes(u.id));
      const { permissions: allPermissionsEqual } = selectedUsers.reduce(
        ({ permissions: aPerms }, { permissions: bPerms }) => {
          return {
            permissions:
              aPerms === bPerms || hasPermission(Permission.ADMIN, aPerms, 0)
                ? aPerms
                : NaN,
          };
        },
        { permissions: selectedUsers[0].permissions }
      );
      const { permissions2: allPermissions2Equal } = selectedUsers.reduce(
        (
          { permissions2: aPerms2 }: { permissions2: number },
          { permissions2: bPerms2 }: { permissions2: number }
        ) => {
          return {
            permissions2: aPerms2 === bPerms2 ? aPerms2 : NaN,
          };
        },
        { permissions2: selectedUsers[0].permissions2 ?? 0 }
      );
      setPermissionState({
        permissions: allPermissionsEqual || 0,
        permissions2: allPermissions2Equal || 0,
      });
    }
  }, [users, selectedUserIds]);

  return (
    <Modal
      title={intl.formatMessage(messages.edituser)}
      onOk={() => {
        updateUsers();
      }}
      okDisabled={isSaving}
      okText={intl.formatMessage(globalMessages.save)}
      onCancel={onCancel}
    >
      <div className="mb-6">
        <PermissionEdit
          actingUser={currentUser}
          currentPermission={permissionState.permissions}
          currentPermission2={permissionState.permissions2}
          onUpdate={(newPermission: number) =>
            setPermissionState((prev) => ({
              ...prev,
              permissions: newPermission,
            }))
          }
          onUpdate2={(newPermission2: number) =>
            setPermissionState((prev) => ({
              ...prev,
              permissions2: newPermission2,
            }))
          }
        />
      </div>
    </Modal>
  );
};

export default BulkEditModal;
