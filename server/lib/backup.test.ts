import dataSource from '@server/datasource';
import databaseBackup from '@server/lib/backup';
import { getSettings } from '@server/lib/settings';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

// VACUUM INTO is mocked: instead of hitting the real DB we capture the target
// path out of the SQL and write a small placeholder file there so size/list
// behavior can be asserted without a live sqlite database.
type QueryFn = (query: string, parameters?: unknown[]) => Promise<unknown>;
const originalQuery: QueryFn = dataSource.query.bind(dataSource);

let tmpDir = '';
let previousConfigDir: string | undefined;

const backupDir = (): string => path.join(tmpDir, 'backups');

const writeSettingsJson = (): void => {
  fs.writeFileSync(
    path.join(tmpDir, 'settings.json'),
    JSON.stringify({ test: true }),
    'utf-8'
  );
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-backup-test-'));
  previousConfigDir = process.env.CONFIG_DIRECTORY;
  process.env.CONFIG_DIRECTORY = tmpDir;
  writeSettingsJson();

  // Mock VACUUM INTO: parse the quoted target path and write a placeholder file.
  (dataSource as unknown as { query: QueryFn }).query = (async (
    query: string
  ) => {
    const match = /VACUUM INTO '(.+)'/.exec(query);
    if (match) {
      fs.writeFileSync(match[1], 'fake-sqlite-snapshot', 'utf-8');
      return [];
    }
    return [];
  }) as QueryFn;

  const settings = getSettings();
  settings.backup = { enabled: true, retention: 7 };
  databaseBackup.cancel();
});

afterEach(() => {
  (dataSource as unknown as { query: QueryFn }).query = originalQuery;
  if (previousConfigDir === undefined) {
    delete process.env.CONFIG_DIRECTORY;
  } else {
    process.env.CONFIG_DIRECTORY = previousConfigDir;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('DatabaseBackup', () => {
  // (a) createBackup writes both files + returns BackupInfo.
  it('createBackup writes the db snapshot + settings copy and returns BackupInfo', async () => {
    const info = await databaseBackup.createBackup();

    assert.ok(info.id.length > 0, 'id should be set');
    assert.ok(info.dbSize > 0, 'db snapshot should be non-empty');
    assert.ok(info.settingsSize > 0, 'settings copy should be non-empty');

    const dbFile = path.join(backupDir(), `seerr-backup-${info.id}.sqlite3`);
    const settingsFile = path.join(
      backupDir(),
      `seerr-backup-${info.id}.settings.json`
    );
    assert.ok(fs.existsSync(dbFile), 'db backup file should exist');
    assert.ok(fs.existsSync(settingsFile), 'settings backup file should exist');

    const list = await databaseBackup.listBackups();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].id, info.id);
  });

  // (b) run() skips when disabled.
  it('run() does nothing when backups are disabled', async () => {
    getSettings().backup = { enabled: false, retention: 7 };

    await databaseBackup.run();

    assert.strictEqual(
      fs.existsSync(backupDir()),
      false,
      'no backup dir should be created when disabled'
    );
  });

  // (c) pruneOld keeps the newest N, deletes the rest (both files per id).
  it('pruneOld keeps the newest N backups and deletes older ones', async () => {
    const dir = backupDir();
    fs.mkdirSync(dir, { recursive: true });

    // Five backups with strictly increasing timestamps (newest sorts first).
    const ids = [
      '2026-06-20T00-00-00-000Z',
      '2026-06-21T00-00-00-000Z',
      '2026-06-22T00-00-00-000Z',
      '2026-06-23T00-00-00-000Z',
      '2026-06-24T00-00-00-000Z',
    ];
    for (const id of ids) {
      fs.writeFileSync(path.join(dir, `seerr-backup-${id}.sqlite3`), 'db');
      fs.writeFileSync(
        path.join(dir, `seerr-backup-${id}.settings.json`),
        '{}'
      );
    }

    await databaseBackup.pruneOld(2);

    const remaining = await databaseBackup.listBackups();
    assert.strictEqual(remaining.length, 2, 'should keep exactly 2');
    assert.deepStrictEqual(
      remaining.map((b) => b.id),
      ['2026-06-24T00-00-00-000Z', '2026-06-23T00-00-00-000Z'],
      'should keep the two newest ids'
    );

    // The pruned ids should have both files removed.
    for (const id of ids.slice(0, 3)) {
      assert.strictEqual(
        fs.existsSync(path.join(dir, `seerr-backup-${id}.sqlite3`)),
        false
      );
      assert.strictEqual(
        fs.existsSync(path.join(dir, `seerr-backup-${id}.settings.json`)),
        false
      );
    }
  });

  // (d) getBackupFilePath rejects a path-traversal id.
  it('getBackupFilePath rejects invalid / path-traversal ids', () => {
    assert.strictEqual(
      databaseBackup.getBackupFilePath('../../etc/passwd', 'db'),
      null
    );
    assert.strictEqual(
      databaseBackup.getBackupFilePath('..\\..\\secret', 'settings'),
      null
    );
    assert.strictEqual(
      databaseBackup.getBackupFilePath('not a timestamp', 'db'),
      null
    );
    // A valid id that does not exist on disk also returns null.
    assert.strictEqual(
      databaseBackup.getBackupFilePath('2099-01-01T00-00-00-000Z', 'db'),
      null
    );
  });

  // Bonus: a valid, existing id resolves to an absolute path.
  it('getBackupFilePath returns an absolute path for a real backup', async () => {
    const info = await databaseBackup.createBackup();
    const dbPath = databaseBackup.getBackupFilePath(info.id, 'db');
    assert.ok(dbPath, 'should resolve a path');
    assert.ok(path.isAbsolute(dbPath as string));
    assert.ok(fs.existsSync(dbPath as string));
  });

  // createBackupManual sets/resets running so the route's 409 check is accurate.
  it('createBackupManual toggles running and rejects a concurrent run', async () => {
    assert.strictEqual(databaseBackup.status().running, false);
    const info = await databaseBackup.createBackupManual();
    assert.ok(info.id.length > 0);
    assert.strictEqual(
      databaseBackup.status().running,
      false,
      'running should reset after the manual backup completes'
    );

    // Simulate an in-flight run: a second manual run must throw (-> route 409).
    databaseBackup.running = true;
    await assert.rejects(() => databaseBackup.createBackupManual());
    databaseBackup.cancel();
  });

  // listBackups discovers settings-only (postgres) backups, not just .sqlite3.
  it('listBackups discovers settings-only backups (postgres path)', async () => {
    const dir = backupDir();
    fs.mkdirSync(dir, { recursive: true });
    const id = '2026-06-25T00-00-00-000Z';
    // Only the settings copy exists (no .sqlite3), as on postgres.
    fs.writeFileSync(path.join(dir, `seerr-backup-${id}.settings.json`), '{}');

    const list = await databaseBackup.listBackups();
    assert.strictEqual(list.length, 1, 'settings-only backup should be listed');
    assert.strictEqual(list[0].id, id);
    assert.strictEqual(list[0].dbSize, 0, 'no db snapshot on postgres');
    assert.ok(list[0].settingsSize > 0);
  });
});
