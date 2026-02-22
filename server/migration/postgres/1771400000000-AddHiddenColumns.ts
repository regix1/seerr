import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddHiddenColumns1771400000000 implements MigrationInterface {
  name = 'AddHiddenColumns1771400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
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

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_media_isHidden"`);
    await queryRunner.query(`DROP INDEX "IDX_media_request_isHidden"`);
    await queryRunner.query(`ALTER TABLE "media" DROP COLUMN "isHidden"`);
    await queryRunner.query(
      `ALTER TABLE "media_request" DROP COLUMN "isHidden"`
    );
  }
}
