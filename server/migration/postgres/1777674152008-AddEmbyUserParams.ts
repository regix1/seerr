import { MediaServerType } from '@server/constants/server';
import { readLegacyMarker } from '@server/lib/settings/migrations/legacyState';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEmbyUserParams1777674152008 implements MigrationInterface {
  name = 'AddEmbyUserParams1777674152008';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user" ADD COLUMN "embyUserId" character varying`
    );
    await queryRunner.query(
      `ALTER TABLE "user" ADD COLUMN "embyDeviceId" character varying`
    );
    await queryRunner.query(
      `ALTER TABLE "user" ADD COLUMN "embyAuthToken" character varying`
    );
    await queryRunner.query(
      `ALTER TABLE "user" ADD COLUMN "embyUsername" character varying`
    );

    // Data migration: when the install was previously EMBY, copy
    // jellyfin_* -> emby_* for users with userType = EMBY (4) and then
    // NULL the jellyfin_* columns on those rows so columns reflect their
    // actual provider going forward.
    const originalType = readLegacyMarker();
    if (originalType === MediaServerType.EMBY) {
      await queryRunner.startTransaction();
      try {
        await queryRunner.query(
          `UPDATE "user"
             SET "embyUserId" = "jellyfinUserId",
                 "embyUsername" = "jellyfinUsername",
                 "embyAuthToken" = "jellyfinAuthToken",
                 "embyDeviceId" = "jellyfinDeviceId"
           WHERE "userType" = 4`
        );
        await queryRunner.query(
          `UPDATE "user"
             SET "jellyfinUserId" = NULL,
                 "jellyfinUsername" = NULL,
                 "jellyfinAuthToken" = NULL,
                 "jellyfinDeviceId" = NULL
           WHERE "userType" = 4`
        );
        await queryRunner.commitTransaction();
      } catch (e) {
        await queryRunner.rollbackTransaction();
        throw e;
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Best-effort reverse: copy emby_* -> jellyfin_* for any rows that have
    // emby identifiers populated, then drop the emby_* columns.
    const originalType = readLegacyMarker();
    if (originalType === MediaServerType.EMBY) {
      await queryRunner.startTransaction();
      try {
        await queryRunner.query(
          `UPDATE "user"
             SET "jellyfinUserId" = "embyUserId",
                 "jellyfinUsername" = "embyUsername",
                 "jellyfinAuthToken" = "embyAuthToken",
                 "jellyfinDeviceId" = "embyDeviceId"
           WHERE "userType" = 4`
        );
        await queryRunner.commitTransaction();
      } catch (e) {
        await queryRunner.rollbackTransaction();
        throw e;
      }
    }

    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "embyUsername"`);
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "embyAuthToken"`);
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "embyDeviceId"`);
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "embyUserId"`);
  }
}
