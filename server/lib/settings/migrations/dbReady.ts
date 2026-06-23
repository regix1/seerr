import dataSource from '@server/datasource';
import { User } from '@server/entity/User';

/**
 * Guard for settings migrations that query TypeORM repositories.
 *
 * Settings migrations run during `getSettings().load()`, which now happens
 * after `dataSource.initialize()` but before the TypeORM schema migrations.
 * On a brand-new config dir the datasource is initialized (so entity metadata
 * exists) yet the `user` table has not been created yet, so a repository query
 * would throw `SQLITE_ERROR: no such table: user`. On existing installs the
 * table is always present, so this returns `true` and the migration runs
 * exactly as before.
 *
 * @returns `true` when the User table exists and can be safely queried.
 */
export const isUserTableReady = async (): Promise<boolean> => {
  if (!dataSource.isInitialized) {
    return false;
  }

  const queryRunner = dataSource.createQueryRunner();
  try {
    const tableName = dataSource.getMetadata(User).tableName;
    return await queryRunner.hasTable(tableName);
  } catch {
    return false;
  } finally {
    await queryRunner.release();
  }
};
