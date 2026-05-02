import type { MigrationInterface, QueryRunner } from 'typeorm';

export class RemoveHiddenColumns1777800000000 implements MigrationInterface {
  name = 'RemoveHiddenColumns1777800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Drop indexes first; SQLite IF EXISTS is supported.
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_media_isHidden"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_media_request_isHidden"`
    );
    // Modern SQLite (3.35.0+) supports ALTER TABLE DROP COLUMN; the
    // bundled better-sqlite3 driver ships with a recent SQLite, matching
    // the pattern used by other recent migrations (e.g. AddEmbyMediaIdColumns).
    await queryRunner.query(`ALTER TABLE "media" DROP COLUMN "isHidden"`);
    await queryRunner.query(
      `ALTER TABLE "media_request" DROP COLUMN "isHidden"`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Re-add columns + indexes mirroring the original AddHiddenColumns
    // migration so a downgrade restores the prior schema shape.
    await queryRunner.query(
      `ALTER TABLE "media_request" ADD COLUMN "isHidden" boolean NOT NULL DEFAULT (0)`
    );
    await queryRunner.query(
      `ALTER TABLE "media" ADD COLUMN "isHidden" boolean NOT NULL DEFAULT (0)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_media_request_isHidden" ON "media_request" ("isHidden")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_media_isHidden" ON "media" ("isHidden")`
    );
  }
}
