import dataSource, { isPgsql } from '@server/datasource';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import fs from 'fs';
import path from 'path';

export interface BackupInfo {
  id: string;
  createdAt: string;
  dbSize: number;
  settingsSize: number;
}

const LABEL = 'Database Backup';
const DB_PREFIX = 'seerr-backup-';
const DB_SUFFIX = '.sqlite3';
const SETTINGS_SUFFIX = '.settings.json';
// ISO-ish timestamp ids only: digits, dashes, one `T` separator and a trailing Z.
// e.g. 2026-06-22T14-30-00-123Z. Anything else is rejected (path traversal guard).
const ID_PATTERN = /^\d{4}-\d{2}-\d{2}T[\d-]+Z$/;

class DatabaseBackup {
  public running = false;

  private getBackupDir(): string {
    return process.env.CONFIG_DIRECTORY
      ? `${process.env.CONFIG_DIRECTORY}/backups`
      : 'config/backups';
  }

  private getSettingsPath(): string {
    return process.env.CONFIG_DIRECTORY
      ? `${process.env.CONFIG_DIRECTORY}/settings.json`
      : 'config/settings.json';
  }

  private createId(): string {
    // Filename-safe ISO timestamp: replace ':' and '.' with '-' so the id stays
    // within the validated charset and is valid on every filesystem.
    return new Date().toISOString().replace(/[:.]/g, '-');
  }

  private isValidId(id: string): boolean {
    return ID_PATTERN.test(id);
  }

  private dbFilePath(dir: string, id: string): string {
    return path.join(dir, `${DB_PREFIX}${id}${DB_SUFFIX}`);
  }

  private settingsFilePath(dir: string, id: string): string {
    return path.join(dir, `${DB_PREFIX}${id}${SETTINGS_SUFFIX}`);
  }

  private fileSize(filePath: string): number {
    try {
      return fs.statSync(filePath).size;
    } catch {
      return 0;
    }
  }

  /**
   * Reconstructs the ISO creation timestamp from a backup id (the id is the
   * filename-safe ISO time produced by createId), so the displayed createdAt is
   * stable regardless of filesystem mtime (which a bind-mount copy / rsync /
   * volume restore can reset). Falls back to epoch if the id can't be parsed.
   */
  private createdAtFromId(id: string): string {
    const [datePart, timePart] = id.split('T');
    if (datePart && timePart) {
      const [hh, mm, ss, ms] = timePart.replace(/Z$/, '').split('-');
      if (hh && mm && ss && ms) {
        const parsed = new Date(`${datePart}T${hh}:${mm}:${ss}.${ms}Z`);
        if (!Number.isNaN(parsed.getTime())) {
          return parsed.toISOString();
        }
      }
    }
    return new Date(0).toISOString();
  }

  /**
   * Job entry point. No-ops when backups are disabled. Creates a snapshot then
   * prunes to the configured retention. Never throws out of the scheduled
   * callback; resets `running` in finally.
   */
  public async run(): Promise<void> {
    if (this.running) {
      logger.warn('Backup already running; skipping this run', {
        label: LABEL,
      });
      return;
    }

    const settings = getSettings();
    if (!settings.backup.enabled) {
      logger.debug('Backups disabled; skipping scheduled run', {
        label: LABEL,
      });
      return;
    }

    this.running = true;
    try {
      const info = await this.createBackup();
      logger.info('Backup created', {
        label: LABEL,
        id: info.id,
        dbSize: info.dbSize,
        settingsSize: info.settingsSize,
      });
      await this.pruneOld(settings.backup.retention);
    } catch (e) {
      logger.error('Backup run failed', {
        label: LABEL,
        errorMessage: e instanceof Error ? e.message : 'Unknown error',
      });
    } finally {
      this.running = false;
    }
  }

  /**
   * Creates a consistent DB snapshot via `VACUUM INTO` (sqlite only) plus a copy
   * of settings.json. On postgres the DB snapshot is skipped with a warning and
   * only settings.json is backed up (sqlite-only for v1).
   */
  public async createBackup(): Promise<BackupInfo> {
    const dir = this.getBackupDir();
    fs.mkdirSync(dir, { recursive: true });

    const id = this.createId();
    const dbTarget = this.dbFilePath(dir, id);
    const settingsTarget = this.settingsFilePath(dir, id);

    if (isPgsql) {
      logger.warn(
        'Postgres backend detected; database snapshot is not supported in v1, backing up settings.json only',
        { label: LABEL }
      );
    } else {
      // VACUUM INTO needs forward slashes and single quotes escaped in the path.
      const escapedTarget = dbTarget.replace(/\\/g, '/').replace(/'/g, "''");
      try {
        await dataSource.query(`VACUUM INTO '${escapedTarget}'`);
      } catch (e) {
        // A failed snapshot can leave a partial file behind that would otherwise
        // be listed as a valid backup; remove it before surfacing the error.
        fs.rmSync(dbTarget, { force: true });
        throw e;
      }
    }

    const settingsSource = this.getSettingsPath();
    if (fs.existsSync(settingsSource)) {
      fs.copyFileSync(settingsSource, settingsTarget);
    } else {
      logger.warn('settings.json not found; skipping settings backup', {
        label: LABEL,
        settingsSource,
      });
    }

    return {
      id,
      createdAt: this.createdAtFromId(id),
      dbSize: this.fileSize(dbTarget),
      settingsSize: this.fileSize(settingsTarget),
    };
  }

  /**
   * Manual ("Backup Now") entry point. Guards against a concurrent run and
   * sets/resets `running` in try/finally so `status().running` is accurate for
   * the route's 409 check and the UI, then returns the created BackupInfo.
   */
  public async createBackupManual(): Promise<BackupInfo> {
    if (this.running) {
      throw new Error('A backup is already in progress.');
    }
    this.running = true;
    try {
      const info = await this.createBackup();
      // Manual runs must honor retention too, otherwise repeated "Backup Now"
      // clicks grow the backup count past the configured limit.
      await this.pruneOld(getSettings().backup.retention);
      return info;
    } finally {
      this.running = false;
    }
  }

  /**
   * Extracts a backup id from a backup filename (either the .sqlite3 snapshot or
   * the .settings.json copy), or null if the entry is not a recognized backup
   * file. Lets postgres (settings-only) backups be discovered too.
   */
  private idFromEntry(entry: string): string | null {
    if (!entry.startsWith(DB_PREFIX)) {
      return null;
    }
    if (entry.endsWith(DB_SUFFIX)) {
      return entry.slice(DB_PREFIX.length, entry.length - DB_SUFFIX.length);
    }
    if (entry.endsWith(SETTINGS_SUFFIX)) {
      return entry.slice(
        DB_PREFIX.length,
        entry.length - SETTINGS_SUFFIX.length
      );
    }
    return null;
  }

  /**
   * Lists existing backups (newest first), derived from either the .sqlite3
   * snapshot or the .settings.json copy so postgres (settings-only) backups are
   * also discovered.
   */
  public async listBackups(): Promise<BackupInfo[]> {
    const dir = this.getBackupDir();
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return [];
    }

    const seen = new Set<string>();
    const backups: BackupInfo[] = [];
    for (const entry of entries) {
      const id = this.idFromEntry(entry);
      if (!id || !this.isValidId(id) || seen.has(id)) {
        continue;
      }
      seen.add(id);
      const dbPath = this.dbFilePath(dir, id);
      const settingsPath = this.settingsFilePath(dir, id);
      backups.push({
        id,
        createdAt: this.createdAtFromId(id),
        dbSize: this.fileSize(dbPath),
        settingsSize: this.fileSize(settingsPath),
      });
    }

    // Sort by the id (the canonical, lexicographically-ordered creation
    // timestamp) so ordering is stable regardless of filesystem mtime.
    backups.sort((a, b) => b.id.localeCompare(a.id));
    return backups;
  }

  /**
   * Removes both files (db + settings) for the given id.
   */
  public async deleteBackup(id: string): Promise<void> {
    if (!this.isValidId(id)) {
      throw new Error('Invalid backup id');
    }
    const dir = this.getBackupDir();
    for (const filePath of [
      this.dbFilePath(dir, id),
      this.settingsFilePath(dir, id),
    ]) {
      try {
        fs.rmSync(filePath, { force: true });
      } catch (e) {
        logger.error('Failed to delete backup file', {
          label: LABEL,
          filePath,
          errorMessage: e instanceof Error ? e.message : 'Unknown error',
        });
      }
    }
  }

  /**
   * Returns the absolute path to a backup file, or null if the id is invalid or
   * the file does not exist. Used by the download route; the id is validated
   * against the timestamp charset to prevent path traversal.
   */
  public getBackupFilePath(id: string, type: 'db' | 'settings'): string | null {
    if (!this.isValidId(id)) {
      return null;
    }
    const dir = this.getBackupDir();
    const filePath =
      type === 'db' ? this.dbFilePath(dir, id) : this.settingsFilePath(dir, id);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return path.resolve(filePath);
  }

  /**
   * Keeps the newest `retention` backups and deletes the rest (both files of
   * each pruned id).
   */
  public async pruneOld(retention: number): Promise<void> {
    if (!Number.isFinite(retention) || retention < 1) {
      return;
    }
    const backups = await this.listBackups();
    const stale = backups.slice(retention);
    for (const backup of stale) {
      await this.deleteBackup(backup.id);
    }
  }

  public status(): { running: boolean } {
    return { running: this.running };
  }

  public cancel(): void {
    this.running = false;
  }
}

export default new DatabaseBackup();
