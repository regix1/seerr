import type { MigrationInterface, QueryRunner } from 'typeorm';

export class RemoveHiddenColumns1777800000000 implements MigrationInterface {
  name = 'RemoveHiddenColumns1777800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Drop indexes if they exist (idempotent for installs that may
    // have manually applied/reverted the original migration).
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_media_isHidden"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_media_request_isHidden"`
    );
    await queryRunner.query(
      `ALTER TABLE "media" DROP COLUMN IF EXISTS "isHidden"`
    );
    await queryRunner.query(
      `ALTER TABLE "media_request" DROP COLUMN IF EXISTS "isHidden"`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Re-add columns + indexes mirroring the original AddHiddenColumns
    // migration so a downgrade restores the prior schema shape.
    await queryRunner.query(
      `ALTER TABLE "media_request" ADD COLUMN "isHidden" boolean NOT NULL DEFAULT false`
    );
    await queryRunner.query(
      `ALTER TABLE "media" ADD COLUMN "isHidden" boolean NOT NULL DEFAULT false`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_media_request_isHidden" ON "media_request" ("isHidden")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_media_isHidden" ON "media" ("isHidden")`
    );
  }
}
