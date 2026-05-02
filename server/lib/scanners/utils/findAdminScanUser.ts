/**
 * Reusable helper that resolves the best admin user for a given media-server
 * provider scan.
 *
 * Lookup order
 * ────────────
 * 1. Owner (id = 1) — if they have credentials for the requested provider.
 *    The owner is treated as a valid scan candidate regardless of their
 *    `permissions` bitmask, because in Seerr convention the owner is always the
 *    admin. Defensively skipping the admin-bit check for id=1 avoids a
 *    pathological state where the first user somehow lost the ADMIN flag.
 * 2. Any other user that has the ADMIN permission bit **and** provider
 *    credentials — ordered by ascending id so the result is deterministic.
 *
 * If no qualifying user exists (including the case where there are no users at
 * all), `reason` is `'no-admin-creds'` and `user` is `null`.
 */

import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import { IsNull, Not } from 'typeorm';

export type ScanProvider = 'plex' | 'jellyfin' | 'emby';

export interface AdminScanUserResult {
  user: User | null;
  reason: 'ok' | 'no-admin-creds';
}

/** Map each provider to the User column that holds the linking credential. */
const PROVIDER_CREDENTIAL_FIELD: Record<ScanProvider, keyof User> = {
  plex: 'plexToken',
  jellyfin: 'jellyfinUserId',
  emby: 'embyUserId',
};

export async function findAdminScanUser(
  provider: ScanProvider
): Promise<AdminScanUserResult> {
  const userRepository = getRepository(User);
  const credField = PROVIDER_CREDENTIAL_FIELD[provider];

  // Step 1: prefer the owner (id=1) when they have the provider credential.
  // The `select` list must include `plexToken` / `jellyfinUserId` / `embyUserId`
  // so TypeORM actually hydrates the field (some columns use `select: false`).
  const ownerCandidate = await userRepository.findOne({
    select: ['id', credField as 'id'] as (keyof User)[],
    where: { id: 1, [credField]: Not(IsNull()) },
  });

  if (ownerCandidate) {
    return { user: ownerCandidate, reason: 'ok' };
  }

  // Step 2: fall back to any admin user with provider credentials.
  // TypeORM's `where` clause cannot express bitwise conditions, so we use a
  // QueryBuilder to emit: `(permissions & adminBit) = adminBit`.
  const adminCandidate = await userRepository
    .createQueryBuilder('user')
    .select([`user.id`, `user.${String(credField)}`])
    .where(`user.${String(credField)} IS NOT NULL`)
    .andWhere('(user.permissions & :adminBit) = :adminBit', {
      adminBit: Permission.ADMIN,
    })
    .orderBy('user.id', 'ASC')
    .getOne();

  if (adminCandidate) {
    return { user: adminCandidate, reason: 'ok' };
  }

  return { user: null, reason: 'no-admin-creds' };
}
