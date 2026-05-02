import { MediaServerType } from '@server/constants/server';
import type {
  AllSettings,
  EmbySettings,
  JellyfinSettings,
} from '@server/lib/settings';
import { writeLegacyMarker } from '@server/lib/settings/migrations/legacyState';
import type { LegacySettings } from '@server/lib/settings/migrations/types';
import fs from 'fs';
import path from 'path';

const SETTINGS_PATH = process.env.CONFIG_DIRECTORY
  ? `${process.env.CONFIG_DIRECTORY}/settings.json`
  : path.join(__dirname, '../../../../config/settings.json');

const defaultJellyfinSettings = (): JellyfinSettings => ({
  name: '',
  ip: '',
  port: 8096,
  useSsl: false,
  urlBase: '',
  externalHostname: '',
  jellyfinForgotPasswordUrl: '',
  libraries: [],
  serverId: '',
  apiKey: '',
});

const defaultEmbySettings = (): EmbySettings => ({
  name: '',
  ip: '',
  port: 8096,
  useSsl: false,
  urlBase: '',
  externalHostname: '',
  forgotPasswordUrl: '',
  libraries: [],
  serverId: '',
  apiKey: '',
});

const migrateSplitEmbyBlock = (settings: LegacySettings): AllSettings => {
  if (
    Array.isArray(settings.migrations) &&
    settings.migrations.includes('0010_split_emby_block')
  ) {
    return settings;
  }

  // Write a backup of the live settings.json BEFORE mutating, so the user
  // can roll back to the pre-migration shape if needed.
  try {
    const buf = fs.readFileSync(SETTINGS_PATH);
    fs.writeFileSync(SETTINGS_PATH + '.bak.0010', buf);
  } catch {
    // settings.json may not yet exist (fresh install) — nothing to back up
  }

  // Persist the original mediaServerType so subsequent TypeORM migrations
  // (AddEmbyUserParams, AddEmbyMediaIdColumns) can detect Emby-origin
  // installs and run the row-level data copy.
  const originalMediaServerType =
    settings.main?.mediaServerType ?? MediaServerType.NOT_CONFIGURED;
  try {
    writeLegacyMarker(originalMediaServerType);
  } catch {
    // legacy-marker write is best-effort; the migration itself is still safe
  }

  const ms = originalMediaServerType;

  if (ms === MediaServerType.EMBY) {
    // Emby install: deep-clone the existing jellyfin block into emby, then
    // reset the jellyfin block to defaults so the two blocks are decoupled
    // going forward. Move the JF login flag to the new Emby flag.
    const existingJellyfin = JSON.parse(
      JSON.stringify(settings.jellyfin ?? defaultJellyfinSettings())
    ) as JellyfinSettings;
    settings.emby = {
      ...defaultEmbySettings(),
      ...existingJellyfin,
      forgotPasswordUrl: existingJellyfin.jellyfinForgotPasswordUrl ?? '',
    };
    settings.jellyfin = defaultJellyfinSettings();
    settings.main.embyLoginEnabled =
      settings.main.jellyfinLoginEnabled ?? false;
    settings.main.jellyfinLoginEnabled = false;
  } else {
    // PLEX, JELLYFIN, NOT_CONFIGURED, or unknown: initialize a fresh emby
    // block; embyLoginEnabled defaults to false; jellyfin block untouched.
    settings.emby = defaultEmbySettings();
    settings.main.embyLoginEnabled = false;
  }

  if (!Array.isArray(settings.migrations)) {
    settings.migrations = [];
  }
  settings.migrations.push('0010_split_emby_block');

  return settings;
};

export default migrateSplitEmbyBlock;
