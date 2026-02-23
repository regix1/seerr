import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSeriesTypeToOverrideRules1771500000000 implements MigrationInterface {
  name = 'AddSeriesTypeToOverrideRules1771500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "override_rule" ADD COLUMN "seriesType" varchar`
    );
    await queryRunner.query(
      `ALTER TABLE "override_rule" ADD COLUMN "targetServerId" integer`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "temporary_override_rule" AS SELECT "id", "radarrServiceId", "sonarrServiceId", "users", "genre", "language", "keywords", "profileId", "rootFolder", "tags", "createdAt", "updatedAt" FROM "override_rule"`
    );
    await queryRunner.query(`DROP TABLE "override_rule"`);
    await queryRunner.query(
      `ALTER TABLE "temporary_override_rule" RENAME TO "override_rule"`
    );
  }
}
