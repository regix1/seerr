import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddHiddenColumns1771400000000 implements MigrationInterface {
  name = 'AddHiddenColumns1771400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
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

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_media_isHidden"`);
    await queryRunner.query(`DROP INDEX "IDX_media_request_isHidden"`);
    // SQLite doesn't support DROP COLUMN directly in older versions,
    // but modern SQLite (3.35.0+) does. For broader compatibility,
    // we use the temp table pattern.
    await queryRunner.query(
      `CREATE TABLE "temporary_media_request" AS SELECT "id", "status", "mediaId", "requestedById", "modifiedById", "createdAt", "updatedAt", "type", "is4k", "serverId", "profileId", "rootFolder", "languageProfileId", "tags", "isAutoRequest" FROM "media_request"`
    );
    await queryRunner.query(`DROP TABLE "media_request"`);
    await queryRunner.query(
      `ALTER TABLE "temporary_media_request" RENAME TO "media_request"`
    );
    await queryRunner.query(
      `CREATE TABLE "temporary_media" AS SELECT "id", "mediaType", "tmdbId", "tvdbId", "imdbId", "status", "status4k", "createdAt", "updatedAt", "lastSeasonChange", "mediaAddedAt", "serviceId", "serviceId4k", "externalServiceId", "externalServiceId4k", "externalServiceSlug", "externalServiceSlug4k", "ratingKey", "ratingKey4k", "jellyfinMediaId", "jellyfinMediaId4k" FROM "media"`
    );
    await queryRunner.query(`DROP TABLE "media"`);
    await queryRunner.query(`ALTER TABLE "temporary_media" RENAME TO "media"`);
  }
}
