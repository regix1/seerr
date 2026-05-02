/**
 * SQLite 53-bit safe limit
 * ------------------------
 * SQLite has no BIGINT — `INTEGER` columns are read back through better-sqlite3
 * as JavaScript Numbers, which preserve integer precision only up to
 * Number.MAX_SAFE_INTEGER (2^53 - 1). `Permission2` intentionally starts above
 * the highest legacy `Permission` bit so a plain numeric permission value can
 * be classified safely at runtime.
 *
 * Legacy umbrella -> sub-permission mapping (kept in sync with `IMPLIED_BY`):
 *   - `Permission.MANAGE_REQUESTS` implies APPROVE_REQUEST, DECLINE_REQUEST,
 *     DELETE_REQUEST, RETRY_REQUEST, VIEW_REQUESTER
 *   - `Permission.REQUEST_ADVANCED` implies REQUEST_ADVANCED_TAGS,
 *     REQUEST_ADVANCED_PATH, REQUEST_ADVANCED_PROFILE
 *   - `Permission.MANAGE_USERS`    implies MANAGE_USERS_CREATE,
 *     MANAGE_USERS_EDIT, MANAGE_USERS_PERMISSIONS, MANAGE_USERS_DELETE
 *   - `Permission.MANAGE_ISSUES`   implies MANAGE_ISSUES_RESOLVE,
 *     MANAGE_ISSUES_DELETE, MANAGE_ISSUES_COMMENT
 *
 * `hasPermission` ORs the umbrella check into every sub-permission check, so
 * legacy admins who only have `MANAGE_REQUESTS` continue to satisfy
 * `hasPermission(Permission2.APPROVE_REQUEST, ...)` etc. without backfill.
 */

export enum Permission {
  NONE = 0,
  ADMIN = 2,
  MANAGE_SETTINGS = 4,
  MANAGE_USERS = 8,
  MANAGE_REQUESTS = 16,
  REQUEST = 32,
  VOTE = 64,
  AUTO_APPROVE = 128,
  AUTO_APPROVE_MOVIE = 256,
  AUTO_APPROVE_TV = 512,
  REQUEST_4K = 1024,
  REQUEST_4K_MOVIE = 2048,
  REQUEST_4K_TV = 4096,
  REQUEST_ADVANCED = 8192,
  REQUEST_VIEW = 16384,
  AUTO_APPROVE_4K = 32768,
  AUTO_APPROVE_4K_MOVIE = 65536,
  AUTO_APPROVE_4K_TV = 131072,
  REQUEST_MOVIE = 262144,
  REQUEST_TV = 524288,
  MANAGE_ISSUES = 1048576,
  VIEW_ISSUES = 2097152,
  CREATE_ISSUES = 4194304,
  AUTO_REQUEST = 8388608,
  AUTO_REQUEST_MOVIE = 16777216,
  AUTO_REQUEST_TV = 33554432,
  RECENT_VIEW = 67108864,
  WATCHLIST_VIEW = 134217728,
  MANAGE_BLOCKLIST = 268435456,
  // Bit 1<<29 (536870912) was previously Permission.HIDDEN_REQUEST.
  // It has been removed; do not reuse this bit in subsequent rounds
  // until any deployed clients with cached values can be considered drained.
  VIEW_BLOCKLIST = 1073741824,
}

/**
 * Granular sub-permissions stored on `user.permissions2`. Values start at
 * 2^31, above the highest legacy `Permission` bit (`VIEW_BLOCKLIST` = 2^30),
 * to avoid confusing Permission and Permission2 values when passed through
 * shared helpers. Because these values exceed the 32-bit signed range, never
 * use JS bitwise operators with Permission2 values; use `hasPermission2Bit`
 * and `togglePermission2Bit` instead.
 */
export enum Permission2 {
  REQUEST_ADVANCED_TAGS = 2147483648,
  REQUEST_ADVANCED_PATH = 4294967296,
  REQUEST_ADVANCED_PROFILE = 8589934592,
  MANAGE_USERS_CREATE = 17179869184,
  MANAGE_USERS_EDIT = 34359738368,
  MANAGE_USERS_PERMISSIONS = 68719476736,
  MANAGE_USERS_DELETE = 137438953472,
  APPROVE_REQUEST = 274877906944,
  DECLINE_REQUEST = 549755813888,
  DELETE_REQUEST = 1099511627776,
  RETRY_REQUEST = 2199023255552,
  VIEW_REQUESTER = 4398046511104,
  MANAGE_ISSUES_RESOLVE = 8796093022208,
  MANAGE_ISSUES_DELETE = 17592186044416,
  MANAGE_ISSUES_COMMENT = 35184372088832,
}

export interface PermissionCheckOptions {
  type: 'and' | 'or';
}

/**
 * Map a `Permission2` sub-permission to the legacy `Permission` umbrella(s)
 * that imply it. Used by `hasPermission` to keep legacy holders functional
 * even when their `permissions2` column has not yet been backfilled.
 */
const IMPLIED_BY: Map<Permission2, Permission[]> = new Map<
  Permission2,
  Permission[]
>([
  [Permission2.REQUEST_ADVANCED_TAGS, [Permission.REQUEST_ADVANCED]],
  [Permission2.REQUEST_ADVANCED_PATH, [Permission.REQUEST_ADVANCED]],
  [Permission2.REQUEST_ADVANCED_PROFILE, [Permission.REQUEST_ADVANCED]],
  [Permission2.MANAGE_USERS_CREATE, [Permission.MANAGE_USERS]],
  [Permission2.MANAGE_USERS_EDIT, [Permission.MANAGE_USERS]],
  [Permission2.MANAGE_USERS_PERMISSIONS, [Permission.MANAGE_USERS]],
  [Permission2.MANAGE_USERS_DELETE, [Permission.MANAGE_USERS]],
  [Permission2.APPROVE_REQUEST, [Permission.MANAGE_REQUESTS]],
  [Permission2.DECLINE_REQUEST, [Permission.MANAGE_REQUESTS]],
  [Permission2.DELETE_REQUEST, [Permission.MANAGE_REQUESTS]],
  [Permission2.RETRY_REQUEST, [Permission.MANAGE_REQUESTS]],
  [Permission2.VIEW_REQUESTER, [Permission.MANAGE_REQUESTS]],
  [Permission2.MANAGE_ISSUES_RESOLVE, [Permission.MANAGE_ISSUES]],
  [Permission2.MANAGE_ISSUES_DELETE, [Permission.MANAGE_ISSUES]],
  [Permission2.MANAGE_ISSUES_COMMENT, [Permission.MANAGE_ISSUES]],
]);

/**
 * Type guard distinguishing `Permission2` bits from `Permission` bits. The
 * Permission2 enum intentionally lives above all legacy Permission values, and
 * every legitimate Permission2 value is registered in IMPLIED_BY.
 */
const isPermission2 = (p: Permission | Permission2): p is Permission2 => {
  return IMPLIED_BY.has(p as Permission2);
};

/**
 * Check a Permission2 bit without JS bitwise operators. Permission2 values are
 * above the 32-bit signed range; bitwise operators would truncate them.
 */
export const hasPermission2Bit = (value: number, bit: Permission2): boolean => {
  if (!Number.isFinite(value) || value <= 0) {
    return false;
  }
  return Math.floor(value / bit) % 2 === 1;
};

export const togglePermission2Bit = (
  value: number,
  bit: Permission2
): number => {
  return hasPermission2Bit(value, bit) ? value - bit : value + bit;
};

/**
 * Resolve a single permission bit against the supplied bitmasks. For a
 * `Permission2` bit, we ALSO accept any of its umbrella `Permission` bits on
 * `value` (so legacy holders continue to satisfy granular checks).
 */
const checkOne = (
  perm: Permission | Permission2,
  value: number,
  value2: number
): boolean => {
  if (isPermission2(perm)) {
    if (hasPermission2Bit(value2, perm)) {
      return true;
    }
    const impliedBy = IMPLIED_BY.get(perm) ?? [];
    return impliedBy.some((legacy) => (value & legacy) !== 0);
  }
  return (value & perm) !== 0;
};

/**
 * Determine whether the supplied bitmask pair satisfies the requested
 * permission(s). `Permission.ADMIN` (bit on `value`) always short-circuits
 * to `true`. For arrays, `options.type` controls AND vs OR semantics.
 *
 * @param permissions Single permission, single Permission2, or mixed array.
 * @param value       Caller's `user.permissions` (legacy bitmask).
 * @param value2      Caller's `user.permissions2` (granular bitmask).
 * @param options     AND (default) vs OR for arrays.
 */
export const hasPermission = (
  permissions: Permission | Permission2 | (Permission | Permission2)[],
  value: number,
  value2: number,
  options: PermissionCheckOptions = { type: 'and' }
): boolean => {
  // No-op check: an explicit "0" / NONE (= 0) means "no permission required".
  if (permissions === 0) {
    return true;
  }

  // ADMIN bypass FIRST — short-circuits every check, including granular ones.
  if ((value & Permission.ADMIN) !== 0) {
    return true;
  }

  if (Array.isArray(permissions)) {
    if (permissions.length === 0) {
      return true;
    }
    switch (options.type) {
      case 'and':
        return permissions.every((p) => checkOne(p, value, value2));
      case 'or':
        return permissions.some((p) => checkOne(p, value, value2));
    }
  }

  return checkOne(permissions, value, value2);
};

/**
 * Largest safe `Permission2` bit. Asserted at module-load time so any future
 * contributor adding a too-high bit gets a runtime error instead of silent
 * truncation under SQLite. (2^53 - 1 = Number.MAX_SAFE_INTEGER.)
 */
const MAX_PERMISSION2_BIT = Math.pow(2, 52);
for (const [name, value] of Object.entries(Permission2)) {
  if (typeof value === 'number' && value > MAX_PERMISSION2_BIT) {
    throw new Error(
      `Permission2.${name} = ${value} exceeds the SQLite 53-bit safe limit (max ${MAX_PERMISSION2_BIT}).`
    );
  }
}
