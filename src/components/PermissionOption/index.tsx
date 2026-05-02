import useSettings from '@app/hooks/useSettings';
import type { User } from '@app/hooks/useUser';
import { Permission } from '@app/hooks/useUser';
import type { Permission2 } from '@server/lib/permissions';
import {
  hasPermission,
  hasPermission2Bit,
  togglePermission2Bit,
} from '@server/lib/permissions';

// A PermissionItem carries EITHER a Permission (legacy bitmask) OR a Permission2 (second bitmask).
// The two fields are mutually exclusive — a given row belongs to exactly one mask.
export type PermissionItem =
  | {
      id: string;
      name: string;
      description: string;
      permission: Permission;
      permission2?: never;
      children?: PermissionItem[];
      requires?: PermissionRequirement[];
    }
  | {
      id: string;
      name: string;
      description: string;
      permission?: never;
      permission2: Permission2;
      children?: PermissionItem[];
      requires?: PermissionRequirement[];
    };

interface PermissionRequirement {
  permissions: Permission[];
  type?: 'and' | 'or';
}

interface PermissionOptionProps {
  option: PermissionItem;
  actingUser?: User;
  currentUser?: User;
  currentPermission: number;
  currentPermission2?: number;
  parent?: PermissionItem;
  onUpdate: (newPermissions: number) => void;
  onUpdate2?: (newPermissions2: number) => void;
}

const PermissionOption = ({
  option,
  actingUser,
  currentUser,
  currentPermission,
  currentPermission2 = 0,
  onUpdate,
  onUpdate2,
  parent,
}: PermissionOptionProps) => {
  const settings = useSettings();

  const autoApprovePermissions = [
    Permission.AUTO_APPROVE,
    Permission.AUTO_APPROVE_MOVIE,
    Permission.AUTO_APPROVE_TV,
    Permission.AUTO_APPROVE_4K,
    Permission.AUTO_APPROVE_4K_MOVIE,
    Permission.AUTO_APPROVE_4K_TV,
  ];

  // Determine which bitmask and bit value applies to this item
  const isPermission2Item = option.permission2 !== undefined;

  let disabled = false;

  // Compute initial checked state based on which mask this item belongs to
  let checked: boolean;
  if (isPermission2Item) {
    checked = hasPermission2Bit(currentPermission2, option.permission2);
  } else {
    checked = hasPermission(option.permission, currentPermission, 0);
  }

  // Determine parent's bit and mask
  const parentIsLegacy =
    parent !== undefined && parent.permission !== undefined;
  const parentIsP2 = parent !== undefined && parent.permission2 !== undefined;

  if (
    // Permissions for user ID 1 (Plex server owner) cannot be changed
    (currentUser && currentUser.id === 1) ||
    // Admin permission automatically bypasses/grants all other permissions (legacy items only for ADMIN check itself)
    (!isPermission2Item &&
      option.permission !== Permission.ADMIN &&
      hasPermission(Permission.ADMIN, currentPermission, 0)) ||
    // For Permission2 items, admin still grants all
    (isPermission2Item &&
      hasPermission(Permission.ADMIN, currentPermission, 0)) ||
    // Manage Requests permission automatically grants all Auto-Approve permissions
    (!isPermission2Item &&
      autoApprovePermissions.includes(option.permission) &&
      hasPermission(Permission.MANAGE_REQUESTS, currentPermission, 0)) ||
    // Selecting a legacy parent permission automatically selects all legacy children
    (parentIsLegacy &&
      parent.permission !== undefined &&
      hasPermission(parent.permission, currentPermission, 0)) ||
    // Selecting a Permission2 parent automatically selects Permission2 children
    (parentIsP2 &&
      parent.permission2 !== undefined &&
      hasPermission2Bit(currentPermission2, parent.permission2)) ||
    // When the legacy parent permission is set, Permission2 children of that legacy parent are also auto-granted
    (isPermission2Item &&
      parentIsLegacy &&
      parent.permission !== undefined &&
      hasPermission(parent.permission, currentPermission, 0))
  ) {
    disabled = true;
    checked = true;
  }

  if (
    // Only the owner can modify the Admin permission
    !isPermission2Item &&
    actingUser?.id !== 1 &&
    option.permission === Permission.ADMIN
  ) {
    disabled = true;
  }

  if (
    // Some permissions are dependent on others; check requirements are fulfilled
    (!isPermission2Item &&
      option.requires &&
      !option.requires.every((requirement) =>
        hasPermission(requirement.permissions, currentPermission, 0, {
          type: requirement.type ?? 'and',
        })
      )) ||
    // Request 4K and Auto-Approve 4K require both 4K movie & 4K series requests to be enabled
    (!isPermission2Item &&
      (option.permission === Permission.REQUEST_4K ||
        option.permission === Permission.AUTO_APPROVE_4K) &&
      (!settings.currentSettings.movie4kEnabled ||
        !settings.currentSettings.series4kEnabled)) ||
    // Request 4K Movie and Auto-Approve 4K Movie require 4K movie requests to be enabled
    (!isPermission2Item &&
      (option.permission === Permission.REQUEST_4K_MOVIE ||
        option.permission === Permission.AUTO_APPROVE_4K_MOVIE) &&
      !settings.currentSettings.movie4kEnabled) ||
    // Request 4K Series and Auto-Approve 4K Series require 4K series requests to be enabled
    (!isPermission2Item &&
      (option.permission === Permission.REQUEST_4K_TV ||
        option.permission === Permission.AUTO_APPROVE_4K_TV) &&
      !settings.currentSettings.series4kEnabled)
  ) {
    disabled = true;
    checked = false;
  }

  const handleChange = () => {
    if (isPermission2Item) {
      const bit = option.permission2;
      const next = togglePermission2Bit(currentPermission2, bit);
      if (onUpdate2) {
        onUpdate2(next);
      }
    } else {
      onUpdate(
        hasPermission(option.permission, currentPermission, 0)
          ? currentPermission - option.permission
          : currentPermission + option.permission
      );
    }
  };

  return (
    <>
      <div
        className={`relative mt-4 flex items-start first:mt-0 ${
          disabled ? 'opacity-50' : ''
        }`}
      >
        <div className="flex h-6 items-center">
          <input
            id={option.id}
            name="permissions"
            type="checkbox"
            disabled={disabled}
            onChange={handleChange}
            checked={checked}
          />
        </div>
        <div className="ml-3 text-sm leading-6">
          <label htmlFor={option.id} className="block" aria-label={option.name}>
            <div className="flex flex-col">
              <span className="font-medium text-white">{option.name}</span>
              <span className="font-normal text-gray-400">
                {option.description}
              </span>
            </div>
          </label>
        </div>
      </div>
      {(option.children ?? []).map((child) => (
        <div key={`permission-child-${child.id}`} className="mt-4 pl-10">
          <PermissionOption
            option={child}
            currentPermission={currentPermission}
            currentPermission2={currentPermission2}
            onUpdate={(newPermission) => onUpdate(newPermission)}
            onUpdate2={onUpdate2}
            parent={option}
          />
        </div>
      ))}
    </>
  );
};

export default PermissionOption;
