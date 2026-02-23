import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSeriesTypeToOverrideRules1771500000000 implements MigrationInterface {
  name = 'AddSeriesTypeToOverrideRules1771500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "override_rule" ADD COLUMN "seriesType" character varying`
    );
    await queryRunner.query(
      `ALTER TABLE "override_rule" ADD COLUMN "targetServerId" integer`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "override_rule" DROP COLUMN "targetServerId"`
    );
    await queryRunner.query(
      `ALTER TABLE "override_rule" DROP COLUMN "seriesType"`
    );
  }
}
