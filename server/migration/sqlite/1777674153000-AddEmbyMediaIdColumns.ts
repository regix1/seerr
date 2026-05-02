import { MediaServerType } from '@server/constants/server';
import {
  deleteLegacyMarker,
  readLegacyMarker,
} from '@server/lib/settings/migrations/legacyState';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEmbyMediaIdColumns1777674153000 implements MigrationInterface {
  name = 'AddEmbyMediaIdColumns1777674153000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media" ADD COLUMN "embyMediaId" varchar`
    );
    await queryRunner.query(
      `ALTER TABLE "media" ADD COLUMN "embyMediaId4k" varchar`
    );

    // Data migration: when the install was previously EMBY, copy
    // jellyfinMediaId -> embyMediaId on every media row, then NULL out
    // the jellyfin columns so each row reflects its actual provider.
    const originalType = readLegacyMarker();
    if (originalType === MediaServerType.EMBY) {
      await queryRunner.startTransaction();
      try {
        await queryRunner.query(
          `UPDATE "media"
             SET "embyMediaId" = "jellyfinMediaId",
                 "embyMediaId4k" = "jellyfinMediaId4k"`
        );
        await queryRunner.query(
          `UPDATE "media"
             SET "jellyfinMediaId" = NULL,
                 "jellyfinMediaId4k" = NULL`
        );
        await queryRunner.commitTransaction();
      } catch (e) {
        await queryRunner.rollbackTransaction();
        throw e;
      }
    }

    // This is the last TypeORM migration that needs the legacy marker —
    // remove it so re-runs are no-ops on subsequent upgrades.
    deleteLegacyMarker();
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const originalType = readLegacyMarker();
    if (originalType === MediaServerType.EMBY) {
      await queryRunner.startTransaction();
      try {
        await queryRunner.query(
          `UPDATE "media"
             SET "jellyfinMediaId" = "embyMediaId",
                 "jellyfinMediaId4k" = "embyMediaId4k"`
        );
        await queryRunner.commitTransaction();
      } catch (e) {
        await queryRunner.rollbackTransaction();
        throw e;
      }
    }

    await queryRunner.query(`ALTER TABLE "media" DROP COLUMN "embyMediaId4k"`);
    await queryRunner.query(`ALTER TABLE "media" DROP COLUMN "embyMediaId"`);
  }
}
