import csurf from '@dr.pogodin/csurf';
import JellyfinAPI from '@server/api/jellyfin';
import PlexAPI from '@server/api/plexapi';
import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import dataSource, { getRepository, isPgsql } from '@server/datasource';
import DiscoverSlider from '@server/entity/DiscoverSlider';
import { Session } from '@server/entity/Session';
import { User } from '@server/entity/User';
import { initI18n } from '@server/i18n';
import { startJobs } from '@server/job/schedule';
import notificationManager from '@server/lib/notifications';
import DiscordAgent from '@server/lib/notifications/agents/discord';
import EmailAgent from '@server/lib/notifications/agents/email';
import GotifyAgent from '@server/lib/notifications/agents/gotify';
import NtfyAgent from '@server/lib/notifications/agents/ntfy';
import PushbulletAgent from '@server/lib/notifications/agents/pushbullet';
import PushoverAgent from '@server/lib/notifications/agents/pushover';
import SlackAgent from '@server/lib/notifications/agents/slack';
import TelegramAgent from '@server/lib/notifications/agents/telegram';
import WebhookAgent from '@server/lib/notifications/agents/webhook';
import WebPushAgent from '@server/lib/notifications/agents/webpush';
import checkOverseerrMerge from '@server/lib/overseerrMerge';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import clearCookies from '@server/middleware/clearcookies';
import routes from '@server/routes';
import avatarproxy from '@server/routes/avatarproxy';
import imageproxy from '@server/routes/imageproxy';
import { appDataPermissions } from '@server/utils/appDataVolume';
import { getAppVersion } from '@server/utils/appVersion';
import createCustomProxyAgent from '@server/utils/customProxyAgent';
import { initializeDnsCache } from '@server/utils/dnsCache';
import restartFlag from '@server/utils/restartFlag';
import { getClientIp } from '@supercharge/request-ip';
import axios from 'axios';
import { TypeormStore } from 'connect-typeorm/out';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import type { Store } from 'express-session';
import session from 'express-session';
import fs from 'fs/promises';
import http from 'http';
import https from 'https';
import yaml from 'js-yaml';
import next from 'next';
import path from 'path';
import swaggerUi from 'swagger-ui-express';

const API_SPEC_PATH = path.join(__dirname, '../seerr-api.yml');

logger.info(`Starting Seerr version ${getAppVersion()}`);
const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

if (!appDataPermissions()) {
  logger.error(
    'Something went wrong while checking config folder! Please ensure the config folder is set up properly.\nhttps://docs.seerr.dev/getting-started'
  );
}

app
  .prepare()
  .then(async () => {
    // Run Overseerr to Seerr migration
    await checkOverseerrMerge();

    // Load settings before TypeORM migrations so settings migrations can
    // write legacy markers consumed by DB data migrations.
    const settings = await getSettings().load();

    const dbConnection = dataSource.isInitialized
      ? dataSource
      : await dataSource.initialize();

    // Run migrations in production
    if (process.env.NODE_ENV === 'production') {
      if (isPgsql) {
        await dbConnection.runMigrations();
      } else {
        await dbConnection.query('PRAGMA foreign_keys=OFF');
        await dbConnection.runMigrations();
        await dbConnection.query('PRAGMA foreign_keys=ON');
      }
    }

    // Repair legacy installs where the Jellyfin settings block actually points
    // at an Emby server. We ask the canonical signal — `/System/Info/Public`
    // returns `ProductName: "Jellyfin Server" | "Emby Server"`. No hostname
    // heuristics, no user-count proxies. If the server is unreachable we skip
    // and try again next startup.
    try {
      const jellyfinConfigured = Boolean(
        settings.jellyfin.ip || settings.jellyfin.apiKey
      );
      const embyEmpty = !settings.emby.ip && !settings.emby.apiKey;

      if (jellyfinConfigured && embyEmpty) {
        const probeClient = JellyfinAPI.forJellyfin(
          settings.jellyfin,
          settings.jellyfin.apiKey || undefined,
          'BOT_seerr'
        );
        const detectedBrand = await probeClient.getServerProductName();

        if (detectedBrand === 'emby') {
          logger.info(
            'Configured Jellyfin server reports ProductName "Emby Server"; moving it to Emby settings.',
            { label: 'Settings' }
          );

          const legacyJellyfin = JSON.parse(JSON.stringify(settings.jellyfin));
          settings.emby = {
            name: legacyJellyfin.name ?? '',
            ip: legacyJellyfin.ip ?? '',
            port: legacyJellyfin.port ?? 8096,
            useSsl: legacyJellyfin.useSsl ?? false,
            urlBase: legacyJellyfin.urlBase ?? '',
            externalHostname: legacyJellyfin.externalHostname ?? '',
            forgotPasswordUrl: legacyJellyfin.jellyfinForgotPasswordUrl ?? '',
            libraries: legacyJellyfin.libraries ?? [],
            serverId: legacyJellyfin.serverId ?? '',
            apiKey: legacyJellyfin.apiKey ?? '',
          };
          settings.jellyfin = {
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
          };
          settings.main.embyLoginEnabled = true;
          settings.main.jellyfinLoginEnabled = false;
          if (settings.main.mediaServerType === MediaServerType.JELLYFIN) {
            settings.main.mediaServerType = MediaServerType.EMBY;
          }

          await dbConnection.query(
            `UPDATE "user"
                SET "embyUserId" = COALESCE("embyUserId", "jellyfinUserId"),
                    "embyUsername" = COALESCE("embyUsername", "jellyfinUsername"),
                    "embyAuthToken" = COALESCE("embyAuthToken", "jellyfinAuthToken"),
                    "embyDeviceId" = COALESCE("embyDeviceId", "jellyfinDeviceId")
              WHERE "userType" = ${UserType.EMBY}`
          );
          await dbConnection.query(
            `UPDATE "user"
                SET "jellyfinUserId" = NULL,
                    "jellyfinUsername" = NULL,
                    "jellyfinAuthToken" = NULL,
                    "jellyfinDeviceId" = NULL
              WHERE "userType" = ${UserType.EMBY}`
          );
          await dbConnection.query(
            `UPDATE "media"
                SET "embyMediaId" = COALESCE("embyMediaId", "jellyfinMediaId"),
                    "embyMediaId4k" = COALESCE("embyMediaId4k", "jellyfinMediaId4k")`
          );
          await dbConnection.query(
            `UPDATE "media"
                SET "jellyfinMediaId" = NULL,
                    "jellyfinMediaId4k" = NULL`
          );
          await settings.save();
        } else if (detectedBrand === null) {
          logger.warn(
            'Could not probe configured Jellyfin server for ProductName; skipping brand-mismatch repair this startup.',
            { label: 'Settings', host: settings.jellyfin.ip }
          );
        }
      }
    } catch (e) {
      logger.warn(
        'Unable to probe configured Jellyfin server for brand mismatch.',
        {
          label: 'Settings',
          errorMessage: (e as Error).message,
        }
      );
    }

    restartFlag.initializeSettings(settings);

    initI18n();

    if (settings.network.forceIpv4First) {
      axios.defaults.httpAgent = new http.Agent({ family: 4 });
      axios.defaults.httpsAgent = new https.Agent({ family: 4 });
    }

    // Add DNS caching
    if (settings.network.dnsCache?.enabled) {
      initializeDnsCache({
        forceMinTtl: settings.network.dnsCache.forceMinTtl,
        forceMaxTtl: settings.network.dnsCache.forceMaxTtl,
      });
    }

    // Register HTTP proxy
    if (settings.network.proxy.enabled) {
      await createCustomProxyAgent(
        settings.network.proxy,
        settings.network.forceIpv4First
      );
    }

    // Migrate library types
    if (
      settings.plex.libraries.length > 1 &&
      !settings.plex.libraries[0].type
    ) {
      const userRepository = getRepository(User);
      const admin = await userRepository.findOne({
        select: { id: true, plexToken: true },
        where: { id: 1 },
      });

      if (admin) {
        logger.info('Migrating Plex libraries to include media type', {
          label: 'Settings',
        });

        const plexapi = new PlexAPI({ plexToken: admin.plexToken });
        await plexapi.syncLibraries();
      }
    }

    // Register Notification Agents
    notificationManager.registerAgents([
      new DiscordAgent(),
      new EmailAgent(),
      new GotifyAgent(),
      new NtfyAgent(),
      new PushbulletAgent(),
      new PushoverAgent(),
      new SlackAgent(),
      new TelegramAgent(),
      new WebhookAgent(),
      new WebPushAgent(),
    ]);

    const userRepository = getRepository(User);
    const totalUsers = await userRepository.count();
    if (totalUsers > 0) {
      startJobs();
    } else {
      logger.info(
        `Skipping starting the scheduled jobs as we have no Plex/Jellyfin/Emby servers setup yet`,
        {
          label: 'Server',
        }
      );
    }

    // Bootstrap Discovery Sliders
    await DiscoverSlider.bootstrapSliders();

    const server = express();
    if (settings.network.trustProxy) {
      server.set('trust proxy', process.env.TRUST_PROXY ?? 'loopback');
    }
    server.use(cookieParser());
    server.use(express.json());
    server.use(express.urlencoded({ extended: true }));
    server.use((req, _res, next) => {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(req, 'ip');
        if (descriptor?.writable === true) {
          Object.defineProperty(req, 'ip', {
            ...descriptor,
            value: getClientIp(req) ?? '',
          });
        }
      } catch (e) {
        logger.error('Failed to attach the ip to the request', {
          label: 'Middleware',
          message: (e as Error).message,
        });
      } finally {
        next();
      }
    });
    if (settings.network.csrfProtection) {
      server.use(
        csurf({
          cookie: {
            httpOnly: true,
            sameSite: true,
            secure: !dev,
            key: '_csrf',
            path: '/',
          },
        })
      );
      server.use((req, res, next) => {
        res.cookie('XSRF-TOKEN', req.csrfToken(), {
          sameSite: true,
          secure: !dev,
        });
        next();
      });
    }

    // Set up sessions
    const sessionRespository = getRepository(Session);
    server.use(
      '/api',
      session({
        secret: settings.sessionSecret,
        resave: false,
        saveUninitialized: false,
        cookie: {
          maxAge: 1000 * 60 * 60 * 24 * 30,
          httpOnly: true,
          sameSite: settings.network.csrfProtection ? 'strict' : 'lax',
          secure: 'auto',
        },
        store: new TypeormStore({
          cleanupLimit: 2,
          ttl: 60 * 60 * 24 * 30,
        }).connect(sessionRespository) as Store,
      })
    );
    const apiSpecContent = await fs.readFile(API_SPEC_PATH, 'utf-8');
    const apiDocs = yaml.load(apiSpecContent) as Record<string, unknown>;
    server.use('/api-docs', swaggerUi.serve, swaggerUi.setup(apiDocs));
    server.use(
      OpenApiValidator.middleware({
        apiSpec: API_SPEC_PATH,
        validateRequests: true,
      })
    );
    /**
     * This is a workaround to convert dates to strings before they are validated by
     * OpenAPI validator. Otherwise, they are treated as objects instead of strings
     * and response validation will fail
     */
    server.use((_req, res, next) => {
      const original = res.json;
      res.json = function jsonp(json) {
        return original.call(this, JSON.parse(JSON.stringify(json)));
      };
      next();
    });
    server.use('/api/v1', routes);

    // Do not set cookies so CDNs can cache them
    server.use('/imageproxy', clearCookies, imageproxy);
    server.use('/avatarproxy', clearCookies, avatarproxy);

    server.get('*path', (req, res) => handle(req, res));
    server.use(
      (
        err: { status: number; message: string; errors: string[] },
        _req: Request,
        res: Response,
        // We must provide a next function for the function signature here even though its not used
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _next: NextFunction
      ) => {
        // format error
        res.status(err.status || 500).json({
          message: err.message,
          errors: err.errors,
        });
      }
    );

    const port = Number(process.env.PORT) || 5055;
    const host = process.env.HOST;
    if (host) {
      server.listen(port, host, () => {
        logger.info(`Server ready on ${host} port ${port}`, {
          label: 'Server',
        });
      });
    } else {
      server.listen(port, () => {
        logger.info(`Server ready on port ${port}`, {
          label: 'Server',
        });
      });
    }
  })
  .catch((err) => {
    logger.error(err.stack);
    process.exit(1);
  });
