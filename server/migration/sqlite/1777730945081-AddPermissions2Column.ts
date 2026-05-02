import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SQLite mirror of the Postgres `AddPermissions2Column` migration. SQLite has
 * no BIGINT — it stores integers in a variable-length encoding and the JS
 * better-sqlite3 driver returns them as JS Numbers, which are safe up to
 * 2^53 - 1. We therefore cap `Permission2` enum bits below 2^53, enforced by
 * a comment + assertion in `server/lib/permissions.ts`.
 *
 * Backfill rules match the Postgres migration; see that file's docblock for
 * the full mapping table.
 */
export class AddPermissions2Column1777730945081 implements MigrationInterface {
  name = 'AddPermissions2Column1777730945081';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // SQLite has no BIGINT; INTEGER is variable-width and safe up to 2^53 - 1
    // when read back as a JS Number through better-sqlite3.
    await queryRunner.query(
      `ALTER TABLE "user" ADD COLUMN "permissions2" INTEGER NOT NULL DEFAULT 0`
    );

    // Backfill in the same migration (atomic with the schema change).
    // MANAGE_REQUESTS (16) -> APPROVE+DECLINE+DELETE+RETRY+VIEW_REQUESTER
    await queryRunner.query(
      `UPDATE "user" SET "permissions2" = "permissions2" | 8521215115264 WHERE "permissions" & 16 != 0`
    );
    // REQUEST_VIEW (16384) -> VIEW_REQUESTER (backfill only; no runtime implication)
    await queryRunner.query(
      `UPDATE "user" SET "permissions2" = "permissions2" | 4398046511104 WHERE "permissions" & 16384 != 0`
    );
    // REQUEST_ADVANCED (8192) -> 3 sub-bits
    await queryRunner.query(
      `UPDATE "user" SET "permissions2" = "permissions2" | 15032385536 WHERE "permissions" & 8192 != 0`
    );
    // MANAGE_USERS (8) -> 4 sub-bits
    await queryRunner.query(
      `UPDATE "user" SET "permissions2" = "permissions2" | 257698037760 WHERE "permissions" & 8 != 0`
    );
    // MANAGE_ISSUES (1048576) -> 3 sub-bits
    await queryRunner.query(
      `UPDATE "user" SET "permissions2" = "permissions2" | 61572651155456 WHERE "permissions" & 1048576 != 0`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Modern SQLite (3.35.0+) supports ALTER TABLE DROP COLUMN; better-sqlite3
    // ships a recent SQLite, matching the pattern used by the recent
    // RemoveHiddenColumns / AddEmbyMediaIdColumns migrations.
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "permissions2"`);
  }
}
