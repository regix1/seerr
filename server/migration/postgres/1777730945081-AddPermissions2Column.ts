import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `user.permissions2` column (a second bitmask alongside the existing
 * `user.permissions`) and backfills sub-permission bits from each user's
 * existing umbrella permissions so legacy admins/managers retain identical
 * effective access after upgrade.
 *
 * Backfill rules (must match `Permission2` enum + `IMPLIED_BY` map in
 * `server/lib/permissions.ts`):
 *   - MANAGE_REQUESTS (16)         -> APPROVE_REQUEST | DECLINE_REQUEST | DELETE_REQUEST | RETRY_REQUEST | VIEW_REQUESTER
 *   - REQUEST_VIEW (16384)         -> VIEW_REQUESTER (backfill only; new users can have request visibility without requester identity)
 *   - REQUEST_ADVANCED (8192)      -> REQUEST_ADVANCED_TAGS | REQUEST_ADVANCED_PATH | REQUEST_ADVANCED_PROFILE
 *   - MANAGE_USERS (8)             -> MANAGE_USERS_CREATE | MANAGE_USERS_EDIT | MANAGE_USERS_PERMISSIONS | MANAGE_USERS_DELETE
 *   - MANAGE_ISSUES (1048576)      -> MANAGE_ISSUES_RESOLVE | MANAGE_ISSUES_DELETE | MANAGE_ISSUES_COMMENT
 *
 * ADMIN bypass continues to short-circuit `hasPermission`, so admin users
 * need no backfill to retain access.
 */
export class AddPermissions2Column1777730945081 implements MigrationInterface {
  name = 'AddPermissions2Column1777730945081';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user" ADD COLUMN "permissions2" BIGINT NOT NULL DEFAULT 0`
    );

    // Backfill in the same migration (atomic with the schema change).
    // MANAGE_REQUESTS (16) -> APPROVE+DECLINE+DELETE+RETRY+VIEW_REQUESTER
    await queryRunner.query(
      `UPDATE "user" SET "permissions2" = "permissions2" | 8521215115264::bigint WHERE "permissions" & 16 != 0`
    );
    // REQUEST_VIEW (16384) -> VIEW_REQUESTER (backfill only; no runtime implication)
    await queryRunner.query(
      `UPDATE "user" SET "permissions2" = "permissions2" | 4398046511104::bigint WHERE "permissions" & 16384 != 0`
    );
    // REQUEST_ADVANCED (8192) -> 3 sub-bits
    await queryRunner.query(
      `UPDATE "user" SET "permissions2" = "permissions2" | 15032385536::bigint WHERE "permissions" & 8192 != 0`
    );
    // MANAGE_USERS (8) -> 4 sub-bits
    await queryRunner.query(
      `UPDATE "user" SET "permissions2" = "permissions2" | 257698037760::bigint WHERE "permissions" & 8 != 0`
    );
    // MANAGE_ISSUES (1048576) -> 3 sub-bits
    await queryRunner.query(
      `UPDATE "user" SET "permissions2" = "permissions2" | 61572651155456::bigint WHERE "permissions" & 1048576 != 0`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user" DROP COLUMN IF EXISTS "permissions2"`
    );
  }
}
