import fs from 'fs';
import path from 'path';

/**
 * Schema persisted to `settings.json.legacy-marker`.
 * Records the pre-migration `mediaServerType` value so subsequent TypeORM
 * migrations can decide whether to run an EMBY-origin data move
 * (jellyfin_* -> emby_*) without re-parsing settings.
 */
export interface LegacyMarker {
  originalMediaServerType: number;
  createdAt: string;
}

const SETTINGS_PATH = process.env.CONFIG_DIRECTORY
  ? `${process.env.CONFIG_DIRECTORY}/settings.json`
  : path.join(__dirname, '../../../../config/settings.json');

const MARKER_PATH = SETTINGS_PATH + '.legacy-marker';
const SETTINGS_BACKUP_0010_PATH = SETTINGS_PATH + '.bak.0010';

export const writeLegacyMarker = (originalType: number): void => {
  const marker: LegacyMarker = {
    originalMediaServerType: originalType,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(MARKER_PATH, JSON.stringify(marker, undefined, 2));
};

export const readLegacyMarker = (): number | null => {
  try {
    const raw = fs.readFileSync(MARKER_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as LegacyMarker;
    if (typeof parsed?.originalMediaServerType === 'number') {
      return parsed.originalMediaServerType;
    }
    return null;
  } catch {
    // The final Emby DB migration removes the marker on success. Rollback can
    // still recover the original mediaServerType from the settings backup that
    // 0010 wrote before mutating settings.json.
    try {
      const raw = fs.readFileSync(SETTINGS_BACKUP_0010_PATH, 'utf-8');
      const parsed = JSON.parse(raw) as {
        main?: { mediaServerType?: number };
      };
      if (typeof parsed?.main?.mediaServerType === 'number') {
        return parsed.main.mediaServerType;
      }
    } catch {
      // ignore — backup may not exist on fresh installs
    }
    return null;
  }
};

export const deleteLegacyMarker = (): void => {
  try {
    fs.unlinkSync(MARKER_PATH);
  } catch {
    // ignore — marker may already be gone
  }
};
