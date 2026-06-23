import type { BackupInfo } from '@server/lib/backup';
import databaseBackup from '@server/lib/backup';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { Router } from 'express';

const backupRoutes = Router();

// Backup management proxies filesystem operations and sensitive config data.
// Restrict every route here to admins even though the parent /settings router
// already enforces ADMIN — keeps this surface safe if the mount point changes.
backupRoutes.use(isAuthenticated(Permission.ADMIN));

// Validate that an id matches the ISO-ish timestamp charset produced by the
// backup service (e.g. 2026-06-22T14-30-00-123Z). Mirrors the service's own
// stricter check so route-accepted ids never fail later in the service (which
// would surface as a 500); this also prevents path traversal via /:id.
const VALID_ID_RE = /^\d{4}-\d{2}-\d{2}T[\d-]+Z$/;

function isValidBackupId(id: string): boolean {
  return VALID_ID_RE.test(id);
}

const backupDir = process.env.CONFIG_DIRECTORY
  ? `${process.env.CONFIG_DIRECTORY}/backups`
  : 'config/backups';

backupRoutes.get('/', async (_req, res, next) => {
  try {
    const settings = getSettings();
    const backups: BackupInfo[] = await databaseBackup.listBackups();

    return res.status(200).json({
      enabled: settings.backup.enabled,
      retention: settings.backup.retention,
      backupDir,
      backups,
    });
  } catch (e) {
    logger.error('Failed to list backups', {
      label: 'Database Backup',
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    return next(e);
  }
});

backupRoutes.post('/', async (req, res, next) => {
  try {
    const settings = getSettings();
    const body = req.body as {
      enabled?: unknown;
      retention?: unknown;
    };

    // Coerce retention defensively: the client number field can serialize as a
    // numeric string. Accept a finite integer >= 1, otherwise keep the current
    // value (silently ignore garbage rather than persist it).
    let retention = settings.backup.retention;
    if (body.retention !== undefined) {
      const parsed =
        typeof body.retention === 'number'
          ? body.retention
          : Number(body.retention);
      if (Number.isInteger(parsed) && parsed >= 1) {
        retention = parsed;
      }
    }

    // Whitelist known fields to avoid arbitrary settings injection.
    settings.backup = {
      enabled:
        typeof body.enabled === 'boolean'
          ? body.enabled
          : settings.backup.enabled,
      retention,
    };

    await settings.save();

    return res.status(200).json({
      enabled: settings.backup.enabled,
      retention: settings.backup.retention,
    });
  } catch (e) {
    logger.error('Failed to save backup settings', {
      label: 'Database Backup',
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    return next(e);
  }
});

backupRoutes.post('/run', async (_req, res) => {
  try {
    if (databaseBackup.status().running) {
      return res
        .status(409)
        .json({ message: 'A backup is already in progress.' });
    }

    const info: BackupInfo = await databaseBackup.createBackupManual();

    return res.status(200).json(info);
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    logger.error('Failed to run backup', {
      label: 'Database Backup',
      errorMessage,
    });
    // Surface the real reason to the admin UI so a failed backup is
    // self-diagnosing instead of a generic toast.
    return res.status(500).json({ message: errorMessage });
  }
});

backupRoutes.get('/:id/download', async (req, res, next) => {
  try {
    const { id } = req.params;
    const type = req.query['type'] as string | undefined;

    if (!isValidBackupId(id)) {
      return res.status(400).json({ message: 'Invalid backup id.' });
    }

    if (type !== 'db' && type !== 'settings') {
      return res.status(400).json({
        message: 'Query parameter "type" must be "db" or "settings".',
      });
    }

    const filePath = databaseBackup.getBackupFilePath(id, type);

    if (!filePath) {
      return res.status(404).json({ message: 'Backup file not found.' });
    }

    const ext = type === 'db' ? 'sqlite3' : 'settings.json';
    const filename = `seerr-backup-${id}.${ext}`;

    return res.download(filePath, filename, (err) => {
      if (err) {
        logger.error('Failed to send backup file', {
          label: 'Database Backup',
          errorMessage: err.message,
        });
        if (!res.headersSent) {
          next(err);
        }
      }
    });
  } catch (e) {
    logger.error('Failed to process download request', {
      label: 'Database Backup',
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    return next(e);
  }
});

backupRoutes.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isValidBackupId(id)) {
      return res.status(400).json({ message: 'Invalid backup id.' });
    }

    await databaseBackup.deleteBackup(id);

    return res.status(204).send();
  } catch (e) {
    logger.error('Failed to delete backup', {
      label: 'Database Backup',
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    return next(e);
  }
});

export default backupRoutes;
