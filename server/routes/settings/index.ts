import JellyfinAPI from '@server/api/jellyfin';
import PlexAPI from '@server/api/plexapi';
import PlexTvAPI from '@server/api/plextv';
import TautulliAPI from '@server/api/tautulli';
import { ApiErrorCode } from '@server/constants/error';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import type { PlexConnection } from '@server/interfaces/api/plexInterfaces';
import type {
  LogMessage,
  LogsResultsResponse,
  SettingsAboutResponse,
} from '@server/interfaces/api/settingsInterfaces';
import { scheduledJobs } from '@server/job/schedule';
import type { AvailableCacheIds } from '@server/lib/cache';
import cacheManager from '@server/lib/cache';
import ImageProxy from '@server/lib/imageproxy';
import { Permission } from '@server/lib/permissions';
import { embyFullScanner } from '@server/lib/scanners/emby';
import { jellyfinFullScanner } from '@server/lib/scanners/jellyfin';
import { plexFullScanner } from '@server/lib/scanners/plex';
import {
  findAdminScanUser,
  type ScanProvider,
} from '@server/lib/scanners/utils/findAdminScanUser';
import type { JobId, Library, MainSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger, { resolveLogLevel, setLogLevel } from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import discoverSettingRoutes from '@server/routes/settings/discover';
import { ApiError } from '@server/types/error';
import { appDataPath } from '@server/utils/appDataVolume';
import { getAppVersion } from '@server/utils/appVersion';
import { dnsCache } from '@server/utils/dnsCache';
import {
  GITHUB_DEVELOP_BRANCH,
  getGithubApiRepoUrl,
  getGithubRepoUrl,
  parseGithubRepoSlug,
} from '@server/utils/githubRepo';
import type { DnsEntries, DnsStats } from 'dns-caching';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import fs from 'fs';
import { escapeRegExp, merge, omit, pick, set, sortBy } from 'lodash';
import { rescheduleJob } from 'node-schedule';
import path from 'path';
import semver from 'semver';
import { URL } from 'url';
import fileflowsRoutes from './fileflows';
import metadataRoutes from './metadata';
import notificationRoutes from './notifications';
import radarrRoutes from './radarr';
import sonarrRoutes from './sonarr';

interface ScanStartError {
  error: string;
  message: string;
}

const PROVIDER_DISPLAY_NAMES: Record<ScanProvider, string> = {
  plex: 'Plex',
  jellyfin: 'Jellyfin',
  emby: 'Emby',
};

const settingsRoutes = Router();

settingsRoutes.use('/notifications', notificationRoutes);
settingsRoutes.use('/radarr', radarrRoutes);
settingsRoutes.use('/sonarr', sonarrRoutes);
settingsRoutes.use('/discover', discoverSettingRoutes);
settingsRoutes.use('/metadatas', metadataRoutes);
settingsRoutes.use('/fileflows', fileflowsRoutes);

const filteredMainSettings = (
  user: User,
  main: MainSettings
): Partial<MainSettings> => {
  if (!user?.hasPermission(Permission.ADMIN)) {
    return omit(main, 'apiKey');
  }

  return main;
};

settingsRoutes.get('/main', (req, res, next) => {
  const settings = getSettings();

  if (!req.user) {
    return next({ status: 400, message: 'User missing from request.' });
  }

  res.status(200).json(filteredMainSettings(req.user, settings.main));
});

settingsRoutes.post('/main', async (req, res) => {
  const settings = getSettings();

  const allowedMainFields: (keyof MainSettings)[] = [
    'applicationTitle',
    'applicationUrl',
    'cacheImages',
    'defaultPermissions',
    'defaultPermissions2',
    'defaultQuotas',
    'hideAvailable',
    'hideBlocklisted',
    'localLogin',
    'mediaServerLogin',
    'newPlexLogin',
    'mediaServerType',
    'plexLoginEnabled',
    'jellyfinLoginEnabled',
    'embyLoginEnabled',
    'partialRequestsEnabled',
    'enableSpecialEpisodes',
    'locale',
    'discoverRegion',
    'streamingRegion',
    'originalLanguage',
    'youtubeUrl',
    'blocklistRegion',
    'blocklistLanguage',
    'blocklistedTags',
    'blocklistedTagsLimit',
    'githubRepo',
  ];

  const sanitizedBody = pick(req.body, allowedMainFields);

  if (
    sanitizedBody.githubRepo !== undefined &&
    !parseGithubRepoSlug(sanitizedBody.githubRepo)
  ) {
    return res.status(400).json({
      message: 'GitHub repository must be in owner/repo format.',
    });
  }

  settings.main = merge(settings.main, sanitizedBody);
  await settings.save();

  return res.status(200).json(settings.main);
});

settingsRoutes.get('/network', (req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.network);
});

settingsRoutes.post('/network', async (req, res) => {
  const settings = getSettings();

  settings.network = merge(settings.network, req.body);
  await settings.save();

  setLogLevel(
    resolveLogLevel(settings.network.logLevel, process.env.LOG_LEVEL)
  );

  return res.status(200).json(settings.network);
});

settingsRoutes.post('/main/regenerate', async (req, res, next) => {
  const settings = getSettings();

  const main = await settings.regenerateApiKey();

  if (!req.user) {
    return next({ status: 500, message: 'User missing from request.' });
  }

  return res.status(200).json(filteredMainSettings(req.user, main));
});

settingsRoutes.get('/plex', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.plex);
});

settingsRoutes.post('/plex', async (req, res, next) => {
  const userRepository = getRepository(User);
  const settings = getSettings();
  try {
    const admin = await userRepository.findOneOrFail({
      select: { id: true, plexToken: true },
      where: { id: 1 },
    });

    Object.assign(settings.plex, req.body);

    const plexClient = new PlexAPI({ plexToken: admin.plexToken });

    const result = await plexClient.getStatus();

    if (!result?.MediaContainer?.machineIdentifier) {
      throw new Error('Server not found');
    }

    settings.plex.machineId = result.MediaContainer.machineIdentifier;
    settings.plex.name = result.MediaContainer.friendlyName;

    await settings.save();
  } catch (e) {
    logger.error('Something went wrong testing Plex connection', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to connect to Plex.',
    });
  }

  return res.status(200).json(settings.plex);
});

settingsRoutes.get('/plex/devices/servers', async (req, res, next) => {
  const userRepository = getRepository(User);
  try {
    const admin = await userRepository.findOneOrFail({
      select: { id: true, plexToken: true },
      where: { id: 1 },
    });
    const plexTvClient = admin.plexToken
      ? new PlexTvAPI(admin.plexToken)
      : null;
    const devices = (await plexTvClient?.getDevices())?.filter((device) => {
      return device.provides.includes('server') && device.owned;
    });
    const settings = getSettings();

    if (devices) {
      await Promise.all(
        devices.map(async (device) => {
          const plexDirectConnections: PlexConnection[] = [];

          device.connection.forEach((connection) => {
            const url = new URL(connection.uri);

            if (url.hostname !== connection.address) {
              const plexDirectConnection = { ...connection };
              plexDirectConnection.address = url.hostname;
              plexDirectConnections.push(plexDirectConnection);

              // Connect to IP addresses over HTTP
              connection.protocol = 'http';
            }
          });

          plexDirectConnections.forEach((plexDirectConnection) => {
            device.connection.push(plexDirectConnection);
          });

          await Promise.all(
            device.connection.map(async (connection) => {
              const plexDeviceSettings = {
                ...settings.plex,
                ip: connection.address,
                port: connection.port,
                useSsl: connection.protocol === 'https',
              };
              const plexClient = new PlexAPI({
                plexToken: admin.plexToken,
                plexSettings: plexDeviceSettings,
                timeout: 5000,
              });

              try {
                await plexClient.getStatus();
                connection.status = 200;
                connection.message = 'OK';
              } catch (e) {
                connection.status = 500;
                connection.message = e.message.split(':')[0];
              }
            })
          );
        })
      );
    }
    return res.status(200).json(devices);
  } catch (e) {
    logger.error('Something went wrong retrieving Plex server list', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve Plex server list.',
    });
  }
});

settingsRoutes.get('/plex/library', async (req, res) => {
  const settings = getSettings();

  if (req.query.sync) {
    const userRepository = getRepository(User);
    const admin = await userRepository.findOneOrFail({
      select: { id: true, plexToken: true },
      where: { id: 1 },
    });
    const plexapi = new PlexAPI({ plexToken: admin.plexToken });

    await plexapi.syncLibraries();
  }

  const enabledLibraries = req.query.enable
    ? (req.query.enable as string).split(',')
    : [];
  settings.plex.libraries = settings.plex.libraries.map((library) => ({
    ...library,
    enabled: enabledLibraries.includes(library.id),
  }));
  await settings.save();
  return res.status(200).json(settings.plex.libraries);
});

settingsRoutes.get('/plex/sync', (_req, res) => {
  return res.status(200).json(plexFullScanner.status());
});

settingsRoutes.post('/plex/sync', async (req, res) => {
  if (req.body.start) {
    const { reason } = await findAdminScanUser('plex');
    if (reason === 'no-admin-creds') {
      const providerName = PROVIDER_DISPLAY_NAMES['plex'];
      return res.status(400).json({
        error: 'NO_ADMIN_CREDENTIALS',
        message: `${providerName} scan cannot run: no admin user has ${providerName} credentials linked. Have a seerr admin sign in via the ${providerName} login button.`,
      } satisfies ScanStartError);
    }
    plexFullScanner.run();
  } else if (req.body.cancel) {
    plexFullScanner.cancel();
  }
  return res.status(200).json(plexFullScanner.status());
});

// ---------------------------------------------------------------------------
// Probe endpoint — detect server brand without saving any settings
// ---------------------------------------------------------------------------
settingsRoutes.post(
  '/probe',
  // Bug 1 fix: allow the probe during first-time setup (before any admin
  // exists).  Once the install is initialized we enforce admin-only access
  // because the route performs outbound network requests on the admin's behalf.
  (req, res, next) => {
    const settings = getSettings();
    if (settings.public.initialized) {
      return isAuthenticated(Permission.ADMIN)(req, res, next);
    }
    return next();
  },
  async (req, res, next) => {
    const { hostname, port, useSsl, urlBase } = req.body as {
      hostname: string;
      port: number;
      useSsl?: boolean;
      urlBase?: string;
    };

    if (!hostname || !port) {
      return next({ status: 400, message: 'hostname and port are required.' });
    }

    const scheme = useSsl ? 'https' : 'http';
    const base = urlBase ?? '';
    const url = `${scheme}://${hostname}:${port}${base}`;

    const api = new JellyfinAPI(
      url,
      undefined,
      undefined,
      MediaServerType.JELLYFIN
    );

    try {
      const info = await api.getServerPublicInfo();

      if (!info) {
        return next({ status: 502, message: 'Could not reach server.' });
      }

      const brand = await api.getServerProductName();

      return res.status(200).json({
        brand,
        productName: info.productName,
        serverName: info.serverName,
        version: info.version,
        serverId: info.id,
      });
    } catch (e) {
      logger.error('Probe endpoint error', {
        label: 'Settings',
        errorMessage: (e as Error).message,
      });
      return next({ status: 502, message: 'Could not reach server.' });
    }
  }
);

settingsRoutes.get('/jellyfin', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.jellyfin);
});

settingsRoutes.post('/jellyfin', async (req, res, next) => {
  const userRepository = getRepository(User);
  const settings = getSettings();

  try {
    const admin = await userRepository.findOneOrFail({
      where: { id: 1 },
      select: ['id', 'jellyfinUserId', 'jellyfinDeviceId', 'embyDeviceId'],
      order: { id: 'ASC' },
    });

    const tempJellyfinSettings = { ...settings.jellyfin, ...req.body };

    const jellyfinClient = JellyfinAPI.forJellyfin(
      tempJellyfinSettings,
      tempJellyfinSettings.apiKey,
      admin.jellyfinDeviceId ?? ''
    );

    const result = await jellyfinClient.getSystemInfo();

    if (!result?.Id) {
      throw new ApiError(result?.status, ApiErrorCode.InvalidUrl);
    }

    // Bug 2 fix: use the full A→B→E→G cascade instead of the raw ProductName
    // field which is absent on old Emby servers.
    const detectedBrand = await jellyfinClient.getServerProductName();
    if (detectedBrand === null) {
      logger.warn(
        'Could not detect server brand on /settings/jellyfin save — defaulting to jellyfin.',
        { label: 'Settings' }
      );
    }

    if (detectedBrand === 'emby') {
      logger.info(
        'Server reported ProductName "Emby Server" on /settings/jellyfin save — auto-routing to Emby settings.',
        { label: 'Settings', productName: result.ProductName }
      );

      const allowedEmbyFields = [
        'ip',
        'port',
        'useSsl',
        'urlBase',
        'externalHostname',
        'forgotPasswordUrl',
        'apiKey',
      ] as const;
      // Map jellyfinForgotPasswordUrl -> forgotPasswordUrl when present.
      const embyShapedBody: Record<string, unknown> = {};
      for (const f of allowedEmbyFields) {
        if (Object.prototype.hasOwnProperty.call(req.body, f)) {
          embyShapedBody[f] = req.body[f];
        }
      }
      if (
        Object.prototype.hasOwnProperty.call(
          req.body,
          'jellyfinForgotPasswordUrl'
        ) &&
        !Object.prototype.hasOwnProperty.call(req.body, 'forgotPasswordUrl')
      ) {
        embyShapedBody.forgotPasswordUrl = req.body.jellyfinForgotPasswordUrl;
      }

      Object.assign(settings.emby, embyShapedBody);
      settings.emby.serverId = result.Id;
      settings.emby.name = result.ServerName;
      settings.main.embyLoginEnabled = true;
      if (settings.main.mediaServerType === MediaServerType.JELLYFIN) {
        settings.main.mediaServerType = MediaServerType.EMBY;
        settings.main.jellyfinLoginEnabled = false;
      }
      await settings.save();

      return res.status(200).json({
        ...settings.emby,
        _detected: {
          brand: 'emby',
          productName: result.ProductName,
          rerouted: true,
        },
      });
    }

    Object.assign(settings.jellyfin, req.body);
    settings.jellyfin.serverId = result.Id;
    settings.jellyfin.name = result.ServerName;
    await settings.save();

    return res.status(200).json({
      ...settings.jellyfin,
      _detected: {
        brand: 'jellyfin',
        productName: result.ProductName,
        rerouted: false,
      },
    });
  } catch (e) {
    if (e instanceof ApiError) {
      logger.error('Something went wrong testing Jellyfin connection', {
        label: 'API',
        status: e.statusCode,
        errorMessage: ApiErrorCode.InvalidUrl,
      });

      return next({
        status: e.statusCode,
        message: ApiErrorCode.InvalidUrl,
      });
    } else {
      logger.error('Something went wrong', {
        label: 'API',
        errorMessage: e.message,
      });

      return next({
        status: e.statusCode ?? 500,
        message: ApiErrorCode.Unknown,
      });
    }
  }
});

settingsRoutes.get('/jellyfin/library', async (req, res, next) => {
  const settings = getSettings();

  if (req.query.sync) {
    const userRepository = getRepository(User);
    const admin = await userRepository.findOneOrFail({
      select: ['id', 'jellyfinDeviceId', 'jellyfinUserId'],
      where: { id: 1 },
      order: { id: 'ASC' },
    });
    const jellyfinClient = JellyfinAPI.forJellyfin(
      settings.jellyfin,
      settings.jellyfin.apiKey,
      admin.jellyfinDeviceId ?? ''
    );

    jellyfinClient.setUserId(admin.jellyfinUserId ?? '');

    const libraries = await jellyfinClient.getLibraries();

    if (libraries.length === 0) {
      // Check if no libraries are found due to the fallback to user views
      // This only affects LDAP users
      const account = await jellyfinClient.getUser();

      // Automatic Library grouping is not supported when user views are used to get library
      if (account.Configuration.GroupedFolders?.length > 0) {
        return next({
          status: 501,
          message: ApiErrorCode.SyncErrorGroupedFolders,
        });
      }

      return next({ status: 404, message: ApiErrorCode.SyncErrorNoLibraries });
    }

    const newLibraries: Library[] = libraries.map((library) => {
      const existing = settings.jellyfin.libraries.find(
        (l) => l.id === library.key && l.name === library.title
      );

      return {
        id: library.key,
        name: library.title,
        enabled: existing?.enabled ?? false,
        type: library.type,
      };
    });

    settings.jellyfin.libraries = newLibraries;
  }

  const enabledLibraries = req.query.enable
    ? (req.query.enable as string).split(',')
    : [];
  settings.jellyfin.libraries = settings.jellyfin.libraries.map((library) => ({
    ...library,
    enabled: enabledLibraries.includes(library.id),
  }));
  await settings.save();
  return res.status(200).json(settings.jellyfin.libraries);
});

settingsRoutes.get('/jellyfin/users', async (req, res) => {
  const settings = getSettings();

  const userRepository = getRepository(User);
  const admin = await userRepository.findOneOrFail({
    select: ['id', 'jellyfinDeviceId', 'jellyfinUserId'],
    where: { id: 1 },
    order: { id: 'ASC' },
  });
  const jellyfinClient = JellyfinAPI.forJellyfin(
    settings.jellyfin,
    settings.jellyfin.apiKey,
    admin.jellyfinDeviceId ?? ''
  );

  jellyfinClient.setUserId(admin.jellyfinUserId ?? '');
  const resp = await jellyfinClient.getUsers();
  const users = resp.users.map((user) => ({
    username: user.Name,
    id: user.Id,
    thumb: `/avatarproxy/${user.Id}`,
    email: user.Name,
  }));

  return res.status(200).json(users);
});

settingsRoutes.get('/jellyfin/sync', (_req, res) => {
  return res.status(200).json(jellyfinFullScanner.status());
});

settingsRoutes.post('/jellyfin/sync', async (req, res) => {
  if (req.body.start) {
    const { reason } = await findAdminScanUser('jellyfin');
    if (reason === 'no-admin-creds') {
      const providerName = PROVIDER_DISPLAY_NAMES['jellyfin'];
      return res.status(400).json({
        error: 'NO_ADMIN_CREDENTIALS',
        message: `${providerName} scan cannot run: no admin user has ${providerName} credentials linked. Have a seerr admin sign in via the ${providerName} login button.`,
      } satisfies ScanStartError);
    }
    jellyfinFullScanner.run();
  } else if (req.body.cancel) {
    jellyfinFullScanner.cancel();
  }
  return res.status(200).json(jellyfinFullScanner.status());
});

// ---------------------------------------------------------------------------
// Emby routes
// ---------------------------------------------------------------------------
settingsRoutes.get('/emby', (_req, res) => {
  const settings = getSettings();
  res.status(200).json(settings.emby);
});

settingsRoutes.post('/emby', async (req, res, next) => {
  const userRepository = getRepository(User);
  const settings = getSettings();

  try {
    const admin = await userRepository.findOneOrFail({
      where: { id: 1 },
      select: ['id', 'embyDeviceId'],
      order: { id: 'ASC' },
    });

    const allowedEmbyFields = [
      'ip',
      'port',
      'useSsl',
      'urlBase',
      'externalHostname',
      'forgotPasswordUrl',
      'apiKey',
    ] as const;

    const tempEmbySettings = {
      ...settings.emby,
      ...pick(req.body, allowedEmbyFields),
    };

    const embyClient = JellyfinAPI.forEmby(
      tempEmbySettings,
      tempEmbySettings.apiKey,
      admin.embyDeviceId ?? ''
    );

    const result = await embyClient.getSystemInfo();

    if (!result?.Id) {
      throw new ApiError(result?.status, ApiErrorCode.InvalidUrl);
    }

    // Bug 2 fix: use the full A→B→E→G cascade instead of the raw ProductName
    // field which is absent on old Emby servers.
    const detectedBrand = await embyClient.getServerProductName();
    if (detectedBrand === null) {
      logger.warn(
        'Could not detect server brand on /settings/emby save — defaulting to emby.',
        { label: 'Settings' }
      );
    }

    if (detectedBrand === 'jellyfin') {
      logger.info(
        'Server reported ProductName "Jellyfin Server" on /settings/emby save — auto-routing to Jellyfin settings.',
        { label: 'Settings', productName: result.ProductName }
      );

      // Translate the emby-shaped body into a jellyfin-shaped one. Note the
      // forgotPasswordUrl rename: emby = `forgotPasswordUrl`,
      // jellyfin = `jellyfinForgotPasswordUrl`.
      const jellyfinPayload: Record<string, unknown> = {};
      for (const f of [
        'ip',
        'port',
        'useSsl',
        'urlBase',
        'externalHostname',
        'apiKey',
      ] as const) {
        if (Object.prototype.hasOwnProperty.call(req.body, f)) {
          jellyfinPayload[f] = req.body[f];
        }
      }
      if (Object.prototype.hasOwnProperty.call(req.body, 'forgotPasswordUrl')) {
        jellyfinPayload.jellyfinForgotPasswordUrl = req.body.forgotPasswordUrl;
      }

      Object.assign(settings.jellyfin, jellyfinPayload);
      settings.jellyfin.serverId = result.Id;
      settings.jellyfin.name = result.ServerName;
      settings.main.jellyfinLoginEnabled = true;
      if (settings.main.mediaServerType === MediaServerType.EMBY) {
        settings.main.mediaServerType = MediaServerType.JELLYFIN;
        settings.main.embyLoginEnabled = false;
      }
      await settings.save();

      return res.status(200).json({
        ...settings.jellyfin,
        _detected: {
          brand: 'jellyfin',
          productName: result.ProductName,
          rerouted: true,
        },
      });
    }

    Object.assign(settings.emby, pick(req.body, allowedEmbyFields));
    settings.emby.serverId = result.Id;
    settings.emby.name = result.ServerName;
    await settings.save();

    return res.status(200).json({
      ...settings.emby,
      _detected: {
        brand: 'emby',
        productName: result.ProductName,
        rerouted: false,
      },
    });
  } catch (e) {
    logger.error('Something went wrong testing Emby connection', {
      label: 'API',
      errorMessage: (e as Error).message,
    });
    return next({
      status: e instanceof ApiError ? e.statusCode : 500,
      message: e instanceof ApiError ? e.errorCode : ApiErrorCode.Unknown,
    });
  }
});

settingsRoutes.get('/emby/library', async (req, res, next) => {
  const settings = getSettings();

  try {
    if (req.query.sync) {
      const userRepository = getRepository(User);
      const admin = await userRepository.findOneOrFail({
        select: ['id', 'embyDeviceId', 'embyUserId'],
        where: { id: 1 },
        order: { id: 'ASC' },
      });
      const embyClient = JellyfinAPI.forEmby(
        settings.emby,
        settings.emby.apiKey,
        admin.embyDeviceId ?? ''
      );

      embyClient.setUserId(admin.embyUserId ?? '');

      const libraries = await embyClient.getLibraries();

      if (libraries.length === 0) {
        return next({
          status: 404,
          message: ApiErrorCode.SyncErrorNoLibraries,
        });
      }

      settings.emby.libraries = libraries.map((library) => {
        const existing = settings.emby.libraries.find(
          (l) => l.id === library.key && l.name === library.title
        );

        return {
          id: library.key,
          name: library.title,
          enabled: existing?.enabled ?? false,
          type: library.type,
        };
      });
    }

    const enabledLibraries = req.query.enable
      ? (req.query.enable as string).split(',')
      : [];
    settings.emby.libraries = settings.emby.libraries.map((library) => ({
      ...library,
      enabled: enabledLibraries.includes(library.id),
    }));
    await settings.save();
    return res.status(200).json(settings.emby.libraries);
  } catch (e) {
    next(e);
  }
});

settingsRoutes.get('/emby/users', async (_req, res) => {
  const settings = getSettings();

  const userRepository = getRepository(User);
  const admin = await userRepository.findOneOrFail({
    select: ['id', 'embyDeviceId', 'embyUserId'],
    where: { id: 1 },
    order: { id: 'ASC' },
  });
  const embyClient = JellyfinAPI.forEmby(
    settings.emby,
    settings.emby.apiKey,
    admin.embyDeviceId ?? ''
  );

  embyClient.setUserId(admin.embyUserId ?? '');
  const resp = await embyClient.getUsers();
  const users = resp.users.map((user) => ({
    username: user.Name,
    id: user.Id,
    thumb: `/avatarproxy/${user.Id}?provider=emby`,
    email: user.Name,
  }));

  return res.status(200).json(users);
});

settingsRoutes.get('/emby/sync', (_req, res) => {
  return res.status(200).json(embyFullScanner.status());
});

settingsRoutes.post('/emby/sync', async (req, res) => {
  if (req.body.start) {
    const { reason } = await findAdminScanUser('emby');
    if (reason === 'no-admin-creds') {
      const providerName = PROVIDER_DISPLAY_NAMES['emby'];
      return res.status(400).json({
        error: 'NO_ADMIN_CREDENTIALS',
        message: `${providerName} scan cannot run: no admin user has ${providerName} credentials linked. Have a seerr admin sign in via the ${providerName} login button.`,
      } satisfies ScanStartError);
    }
    embyFullScanner.run();
  } else if (req.body.cancel) {
    embyFullScanner.cancel();
  }
  return res.status(200).json(embyFullScanner.status());
});

settingsRoutes.get('/tautulli', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.tautulli);
});

settingsRoutes.post('/tautulli', async (req, res, next) => {
  const settings = getSettings();

  Object.assign(settings.tautulli, req.body);

  if (settings.tautulli.hostname) {
    try {
      const tautulliClient = new TautulliAPI(settings.tautulli);

      const result = await tautulliClient.getInfo();

      if (!semver.gte(semver.coerce(result?.tautulli_version) ?? '', '2.9.0')) {
        throw new Error('Tautulli version not supported');
      }

      await settings.save();
    } catch (e) {
      logger.error('Something went wrong testing Tautulli connection', {
        label: 'API',
        errorMessage: e.message,
      });
      return next({
        status: 500,
        message: 'Unable to connect to Tautulli.',
      });
    }
  }

  return res.status(200).json(settings.tautulli);
});

settingsRoutes.get(
  '/plex/users',
  isAuthenticated(Permission.MANAGE_USERS),
  async (req, res, next) => {
    const userRepository = getRepository(User);
    const qb = userRepository.createQueryBuilder('user');

    try {
      const admin = await userRepository.findOneOrFail({
        select: { id: true, plexToken: true },
        where: { id: 1 },
      });
      const plexApi = new PlexTvAPI(admin.plexToken ?? '');
      const plexUsers = (await plexApi.getUsers()).MediaContainer.User.map(
        (user) => user.$
      ).filter((user) => user.email);

      const unimportedPlexUsers: {
        id: string;
        title: string;
        username: string;
        email: string;
        thumb: string;
      }[] = [];

      const plexIds = plexUsers.map((plexUser) => plexUser.id);
      const plexEmails = plexUsers.map((plexUser) =>
        plexUser.email.toLowerCase()
      );
      if (!plexIds.length) plexIds.push('-1');
      if (!plexEmails.length) plexEmails.push('@');

      const existingUsers = await qb
        .where('user.plexId IN (:...plexIds)', { plexIds })
        .orWhere('user.email IN (:...plexEmails)', { plexEmails })
        .getMany();

      await Promise.all(
        plexUsers.map(async (plexUser) => {
          if (
            !existingUsers.find(
              (user) =>
                user.plexId === parseInt(plexUser.id) ||
                user.email === plexUser.email.toLowerCase()
            ) &&
            (await plexApi.checkUserAccess(parseInt(plexUser.id)))
          ) {
            unimportedPlexUsers.push(plexUser);
          }
        })
      );

      return res.status(200).json(sortBy(unimportedPlexUsers, 'username'));
    } catch (e) {
      logger.error('Something went wrong getting unimported Plex users', {
        label: 'API',
        errorMessage: e.message,
      });
      next({
        status: 500,
        message: 'Unable to retrieve unimported Plex users.',
      });
    }
  }
);

settingsRoutes.get(
  '/logs',
  rateLimit({ windowMs: 60 * 1000, max: 50 }),
  (req, res, next) => {
    const pageSize = req.query.take ? Number(req.query.take) : 25;
    const skip = req.query.skip ? Number(req.query.skip) : 0;
    const search = (req.query.search as string) ?? '';
    const searchRegexp = new RegExp(escapeRegExp(search), 'i');

    let filter: string[] = [];
    switch (req.query.filter) {
      case 'debug':
        filter.push('debug');
      // falls through
      case 'info':
        filter.push('info');
      // falls through
      case 'warn':
        filter.push('warn');
      // falls through
      case 'error':
        filter.push('error');
        break;
      default:
        filter = ['debug', 'info', 'warn', 'error'];
    }

    const logFile = process.env.CONFIG_DIRECTORY
      ? `${process.env.CONFIG_DIRECTORY}/logs/.machinelogs.json`
      : path.join(__dirname, '../../../config/logs/.machinelogs.json');
    const logs: LogMessage[] = [];
    const logMessageProperties = [
      'timestamp',
      'level',
      'label',
      'message',
      'data',
    ];

    const deepValueStrings = (obj: Record<string, unknown>): string[] => {
      const values = [];

      for (const val of Object.values(obj)) {
        if (typeof val === 'string') {
          values.push(val);
        } else if (typeof val === 'number') {
          values.push(val.toString());
        } else if (val !== null && typeof val === 'object') {
          values.push(...deepValueStrings(val as Record<string, unknown>));
        }
      }

      return values;
    };

    try {
      fs.readFileSync(logFile, 'utf-8')
        .split('\n')
        .forEach((line) => {
          if (!line.length) return;

          const logMessage = JSON.parse(line);

          if (!filter.includes(logMessage.level)) {
            return;
          }

          if (
            !Object.keys(logMessage).every((key) =>
              logMessageProperties.includes(key)
            )
          ) {
            Object.keys(logMessage)
              .filter((prop) => !logMessageProperties.includes(prop))
              .forEach((prop) => {
                set(logMessage, `data.${prop}`, logMessage[prop]);
              });
          }

          if (req.query.search) {
            if (
              // label and data are sometimes undefined
              !searchRegexp.test(logMessage.label ?? '') &&
              !searchRegexp.test(logMessage.message) &&
              !deepValueStrings(logMessage.data ?? {}).some((val) =>
                searchRegexp.test(val)
              )
            ) {
              return;
            }
          }

          logs.push(logMessage);
        });

      const displayedLogs = logs.reverse().slice(skip, skip + pageSize);

      return res.status(200).json({
        pageInfo: {
          pages: Math.ceil(logs.length / pageSize),
          pageSize,
          results: logs.length,
          page: Math.ceil(skip / pageSize) + 1,
        },
        results: displayedLogs,
      } as LogsResultsResponse);
    } catch (error) {
      logger.error('Something went wrong while retrieving logs', {
        label: 'Logs',
        errorMessage: error.message,
      });
      return next({
        status: 500,
        message: 'Unable to retrieve logs.',
      });
    }
  }
);

settingsRoutes.get('/jobs', (_req, res) => {
  return res.status(200).json(
    scheduledJobs.map((job) => ({
      id: job.id,
      name: job.name,
      type: job.type,
      interval: job.interval,
      cronSchedule: job.cronSchedule,
      nextExecutionTime: job.job.nextInvocation(),
      running: job.running ? job.running() : false,
    }))
  );
});

settingsRoutes.post<{ jobId: string }>('/jobs/:jobId/run', (req, res, next) => {
  const scheduledJob = scheduledJobs.find((job) => job.id === req.params.jobId);

  if (!scheduledJob) {
    return next({ status: 404, message: 'Job not found.' });
  }

  scheduledJob.job.invoke();

  return res.status(200).json({
    id: scheduledJob.id,
    name: scheduledJob.name,
    type: scheduledJob.type,
    interval: scheduledJob.interval,
    cronSchedule: scheduledJob.cronSchedule,
    nextExecutionTime: scheduledJob.job.nextInvocation(),
    running: scheduledJob.running ? scheduledJob.running() : false,
  });
});

settingsRoutes.post<{ jobId: JobId }>(
  '/jobs/:jobId/cancel',
  (req, res, next) => {
    const scheduledJob = scheduledJobs.find(
      (job) => job.id === req.params.jobId
    );

    if (!scheduledJob) {
      return next({ status: 404, message: 'Job not found.' });
    }

    if (scheduledJob.cancelFn) {
      scheduledJob.cancelFn();
    }

    return res.status(200).json({
      id: scheduledJob.id,
      name: scheduledJob.name,
      type: scheduledJob.type,
      interval: scheduledJob.interval,
      cronSchedule: scheduledJob.cronSchedule,
      nextExecutionTime: scheduledJob.job.nextInvocation(),
      running: scheduledJob.running ? scheduledJob.running() : false,
    });
  }
);

settingsRoutes.post<{ jobId: JobId }>(
  '/jobs/:jobId/schedule',
  async (req, res, next) => {
    const scheduledJob = scheduledJobs.find(
      (job) => job.id === req.params.jobId
    );

    if (!scheduledJob) {
      return next({ status: 404, message: 'Job not found.' });
    }

    const result = rescheduleJob(scheduledJob.job, req.body.schedule);
    const settings = getSettings();

    if (result) {
      settings.jobs[scheduledJob.id].schedule = req.body.schedule;
      await settings.save();

      scheduledJob.cronSchedule = req.body.schedule;

      return res.status(200).json({
        id: scheduledJob.id,
        name: scheduledJob.name,
        type: scheduledJob.type,
        interval: scheduledJob.interval,
        cronSchedule: scheduledJob.cronSchedule,
        nextExecutionTime: scheduledJob.job.nextInvocation(),
        running: scheduledJob.running ? scheduledJob.running() : false,
      });
    } else {
      return next({ status: 400, message: 'Invalid job schedule.' });
    }
  }
);

settingsRoutes.get('/cache', async (_req, res) => {
  const cacheManagerCaches = cacheManager.getAllCaches();

  const apiCaches = Object.values(cacheManagerCaches).map((cache) => ({
    id: cache.id,
    name: cache.name,
    stats: cache.getStats(),
  }));

  const tmdbImageCache = await ImageProxy.getImageStats('tmdb');
  const avatarImageCache = await ImageProxy.getImageStats('avatar');

  const stats: DnsStats | undefined = dnsCache?.getStats();
  const entries: DnsEntries | undefined = dnsCache?.getCacheEntries();

  return res.status(200).json({
    apiCaches,
    imageCache: {
      tmdb: tmdbImageCache,
      avatar: avatarImageCache,
    },
    dnsCache: {
      stats,
      entries,
    },
  });
});

settingsRoutes.post<{ cacheId: AvailableCacheIds }>(
  '/cache/:cacheId/flush',
  (req, res, next) => {
    const cache = cacheManager.getCache(req.params.cacheId);

    if (cache) {
      cache.flush();
      return res.status(204).send();
    }

    next({ status: 404, message: 'Cache not found.' });
  }
);

settingsRoutes.post<{ dnsEntry: string }>(
  '/cache/dns/:dnsEntry/flush',
  (req, res, next) => {
    const dnsEntry = req.params.dnsEntry;

    if (dnsCache) {
      dnsCache.clear(dnsEntry);
      return res.status(204).send();
    }

    next({ status: 404, message: 'Cache not found.' });
  }
);

settingsRoutes.post(
  '/initialize',
  isAuthenticated(Permission.ADMIN),
  async (_req, res) => {
    const settings = getSettings();

    settings.public.initialized = true;
    await settings.save();

    return res.status(200).json(settings.public);
  }
);

settingsRoutes.get('/about', async (req, res) => {
  const mediaRepository = getRepository(Media);
  const mediaRequestRepository = getRepository(MediaRequest);

  const totalMediaItems = await mediaRepository.count();
  const totalRequests = await mediaRequestRepository.count();

  const settings = getSettings();
  const githubRepo = settings.main.githubRepo;
  const githubRepoUrl = getGithubRepoUrl(githubRepo);
  const githubApiRepoUrl = getGithubApiRepoUrl(githubRepo);

  return res.status(200).json({
    version: getAppVersion(),
    totalMediaItems,
    totalRequests,
    tz: process.env.TZ,
    appDataPath: appDataPath(),
    githubRepo,
    githubRepoUrl,
    githubDevelopBranch: GITHUB_DEVELOP_BRANCH,
    githubReleasesUrl: `${githubApiRepoUrl}/releases?per_page=20`,
  } as SettingsAboutResponse);
});

export default settingsRoutes;
