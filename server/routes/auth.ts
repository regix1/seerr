import JellyfinAPI from '@server/api/jellyfin';
import PlexTvAPI from '@server/api/plextv';
import { ApiErrorCode } from '@server/constants/error';
import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { startJobs } from '@server/job/schedule';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { checkAvatarChanged } from '@server/routes/avatarproxy';
import { ApiError } from '@server/types/error';
import { getAppVersion } from '@server/utils/appVersion';
import { getHostname } from '@server/utils/getHostname';
import axios from 'axios';
import { Router } from 'express';
import net from 'net';
import validator from 'validator';

const authRoutes = Router();

authRoutes.get('/me', isAuthenticated(), async (req, res) => {
  const userRepository = getRepository(User);
  if (!req.user) {
    return res.status(500).json({
      status: 500,
      error: 'Please sign in.',
    });
  }
  const user = await userRepository.findOneOrFail({
    where: { id: req.user.id },
  });

  // check if email is required in settings and if user has an valid email
  const settings = await getSettings();
  if (
    settings.notifications.agents.email.options.userEmailRequired &&
    !validator.isEmail(user.email, { require_tld: false })
  ) {
    user.warnings.push('userEmailRequired');
    logger.warn(`User ${user.username} has no valid email address`);
  }

  return res.status(200).json(user);
});

authRoutes.post('/plex', async (req, res, next) => {
  const settings = getSettings();
  const userRepository = getRepository(User);
  const body = req.body as { authToken?: string };

  if (!body.authToken) {
    return next({
      status: 500,
      message: 'Authentication token required.',
    });
  }

  const hasAnyUsers = (await userRepository.count()) > 0;

  if (!settings.main.plexLoginEnabled && hasAnyUsers) {
    return res.status(500).json({ error: 'Plex login is disabled' });
  }
  try {
    // First we need to use this auth token to get the user's email from plex.tv
    const plextv = new PlexTvAPI(body.authToken);
    const account = await plextv.getUser();

    // Next let's see if the user already exists
    // User-accepted: silent email-match merge enables one seerr account to hold both Plex and Jellyfin identities. Shared-email risk is accepted.
    let user = await userRepository
      .createQueryBuilder('user')
      .where('user.plexId = :id', { id: account.id })
      .orWhere('user.email = :email', {
        email: account.email.toLowerCase(),
      })
      .getOne();

    if (!user && !hasAnyUsers) {
      user = new User({
        email: account.email,
        plexUsername: account.username,
        plexId: account.id,
        plexToken: account.authToken,
        permissions: Permission.ADMIN,
        avatar: account.thumb,
        userType: UserType.PLEX,
      });

      if (settings.main.mediaServerType === MediaServerType.NOT_CONFIGURED) {
        settings.main.mediaServerType = MediaServerType.PLEX;
      }
      settings.main.plexLoginEnabled = true;
      await settings.save();
      startJobs();

      await userRepository.save(user);
    } else {
      const mainUser = await userRepository.findOneOrFail({
        select: { id: true, plexToken: true, plexId: true, email: true },
        where: { id: 1 },
      });
      const mainPlexTv = new PlexTvAPI(mainUser.plexToken ?? '');

      if (!account.id) {
        logger.error('Plex ID was missing from Plex.tv response', {
          label: 'API',
          ip: req.ip,
          email: account.email,
          plexUsername: account.username,
        });

        return next({
          status: 500,
          message: 'Something went wrong. Try again.',
        });
      }

      if (
        account.id === mainUser.plexId ||
        (account.email === mainUser.email && !mainUser.plexId) ||
        (await mainPlexTv.checkUserAccess(account.id))
      ) {
        if (user) {
          if (!user.plexId) {
            logger.info(
              'Found matching Plex user; updating user with Plex data',
              {
                label: 'API',
                ip: req.ip,
                email: user.email,
                userId: user.id,
                plexId: account.id,
                plexUsername: account.username,
              }
            );
          }

          // Block account takeover of bootstrap admin via email collision
          if (
            user.id === 1 &&
            user.plexId != null &&
            user.plexId !== account.id
          ) {
            return next({
              status: 403,
              message: 'Cannot replace primary admin Plex account',
            });
          }

          user.plexToken = body.authToken;
          user.plexId = account.id;
          user.avatar = account.thumb;
          user.email = account.email;
          user.plexUsername = account.username;
          user.userType = UserType.PLEX;

          await userRepository.save(user);
          user.setDisplayName();
        } else if (!settings.main.newPlexLogin) {
          logger.warn(
            'Failed sign-in attempt by unimported Plex user with access to the media server',
            {
              label: 'API',
              ip: req.ip,
              email: account.email,
              plexId: account.id,
              plexUsername: account.username,
            }
          );
          return next({
            status: 403,
            message: 'Access denied.',
          });
        } else {
          logger.info(
            'Sign-in attempt from Plex user with access to the media server; creating new Seerr user',
            {
              label: 'API',
              ip: req.ip,
              email: account.email,
              plexId: account.id,
              plexUsername: account.username,
            }
          );
          user = new User({
            email: account.email,
            plexUsername: account.username,
            plexId: account.id,
            plexToken: account.authToken,
            permissions: settings.main.defaultPermissions,
            avatar: account.thumb,
            userType: UserType.PLEX,
          });

          await userRepository.save(user);
        }
      } else {
        logger.warn(
          'Failed sign-in attempt by Plex user without access to the media server',
          {
            label: 'API',
            ip: req.ip,
            email: account.email,
            plexId: account.id,
            plexUsername: account.username,
          }
        );
        return next({
          status: 403,
          message: 'Access denied.',
        });
      }
    }

    // Set logged in session
    if (req.session) {
      req.session.userId = user.id;
    }

    return res.status(200).json(user?.filter() ?? {});
  } catch (e) {
    logger.error('Something went wrong authenticating with Plex account', {
      label: 'API',
      errorMessage: e.message,
      ip: req.ip,
    });
    return next({
      status: 500,
      message: 'Unable to authenticate.',
    });
  }
});

function getUserAvatarUrl(user: User, provider: 'jellyfin' | 'emby'): string {
  const userId =
    provider === 'emby' ? (user.embyUserId ?? '') : (user.jellyfinUserId ?? '');
  return `/avatarproxy/${userId}?provider=${provider}&v=${user.avatarVersion}`;
}

/**
 * Resolve an IPv4/IPv6 client IP string from the request ip field.
 */
function resolveClientIp(rawIp: string | undefined): string | undefined {
  if (!rawIp) return undefined;
  if (net.isIPv4(rawIp)) return rawIp;
  if (net.isIPv6(rawIp)) {
    return rawIp.startsWith('::ffff:') ? rawIp.substring(7) : rawIp;
  }
  return undefined;
}

authRoutes.post('/jellyfin', async (req, res, next) => {
  const settings = getSettings();
  const userRepository = getRepository(User);
  const body = req.body as {
    username?: string;
    password?: string;
    hostname?: string;
    port?: number;
    urlBase?: string;
    useSsl?: boolean;
    email?: string;
  };

  const hasAnyUsers = (await userRepository.count()) > 0;

  if (!settings.main.jellyfinLoginEnabled && hasAnyUsers) {
    return res.status(401).json({ error: 'Jellyfin login is disabled' });
  }

  if (!body.username) {
    return res.status(500).json({ error: 'You must provide an username' });
  } else if (settings.jellyfin.ip !== '' && body.hostname) {
    return res
      .status(500)
      .json({ error: 'Jellyfin hostname already configured' });
  } else if (settings.jellyfin.ip === '' && !body.hostname) {
    return res.status(500).json({ error: 'No hostname provided.' });
  }

  try {
    // Build a JellyfinSettings-shaped object from saved settings, or from
    // body fields when this is a fresh setup with no saved hostname yet.
    const jellyfinSettingsForLogin =
      settings.jellyfin.ip !== ''
        ? settings.jellyfin
        : {
            ...settings.jellyfin,
            ip: body.hostname ?? '',
            port: body.port ?? 8096,
            useSsl: body.useSsl,
            urlBase: body.urlBase,
          };
    // Try to find deviceId that corresponds to jellyfin user, else generate a new one
    let user = await userRepository.findOne({
      where: { jellyfinUsername: body.username },
      select: { id: true, jellyfinDeviceId: true },
    });

    let deviceId = 'BOT_seerr';
    if (user && user.id === 1) {
      deviceId = 'BOT_seerr';
    } else if (user && user.jellyfinDeviceId) {
      deviceId = user.jellyfinDeviceId;
    } else if (body.username) {
      deviceId = Buffer.from(`BOT_seerr_${body.username}`).toString('base64');
    }

    // Authenticate against the Jellyfin server
    const jellyfinserver = JellyfinAPI.forJellyfin(
      jellyfinSettingsForLogin,
      undefined,
      deviceId
    );
    const clientIp = resolveClientIp(req.ip);

    const account = await jellyfinserver.login(
      body.username,
      body.password,
      clientIp
    );

    // Brand-mismatch detection: the auth succeeded but the server is actually Emby.
    // Return 400 so the frontend can silently re-dispatch to /auth/emby.
    const detectedBrandJf = await jellyfinserver.getServerProductName();
    if (detectedBrandJf === 'emby') {
      return res.status(400).json({
        message: 'Server is actually Emby. Re-dispatching to /auth/emby.',
        errorCode: ApiErrorCode.ServerBrandMismatch,
        detectedBrand: 'emby',
      });
    }
    if (detectedBrandJf === null) {
      logger.warn(
        'Could not determine server brand after Jellyfin auth; proceeding as Jellyfin.',
        { label: 'Auth', ip: req.ip }
      );
    }

    // Look up by jellyfinUserId first
    // User-accepted: silent email-match merge enables one seerr account to hold Plex + Jellyfin + Emby identities.
    user = await userRepository.findOne({
      where: { jellyfinUserId: account.User.Id },
    });

    // Email-fallback merge: if no jellyfinUserId match, look up by email
    if (!user && body.email) {
      const emailMatchedUser = await userRepository.findOne({
        where: { email: body.email.toLowerCase() },
      });
      if (emailMatchedUser) {
        if (!emailMatchedUser.jellyfinUserId) {
          // Silent merge: add jellyfin* columns to the existing row without touching other providers
          logger.info(
            'Auto-merged Jellyfin login into existing user via email match',
            { userId: emailMatchedUser.id, email: emailMatchedUser.email }
          );
          emailMatchedUser.jellyfinUserId = account.User.Id;
          emailMatchedUser.jellyfinUsername = account.User.Name;
          emailMatchedUser.jellyfinDeviceId = deviceId;
          emailMatchedUser.jellyfinAuthToken = account.AccessToken;
          // userType is preserved — it records the originating provider, not an exclusion
          await userRepository.save(emailMatchedUser);
          emailMatchedUser.setDisplayName();
          user = emailMatchedUser;
        } else if (emailMatchedUser.jellyfinUserId !== account.User.Id) {
          logger.warn(
            'Jellyfin login rejected: email matches a different Jellyfin account already linked',
            {
              email: emailMatchedUser.email,
              existingJellyfinUserId: emailMatchedUser.jellyfinUserId,
              incomingJellyfinUserId: account.User.Id,
            }
          );
          return res.status(409).json({
            message:
              'Email matches a different Jellyfin account already linked.',
          });
        }
        // else: same jellyfinUserId — fall through normally
      }
    }

    const missingAdminUser = !user && !hasAnyUsers;
    if (
      missingAdminUser ||
      settings.main.mediaServerType === MediaServerType.NOT_CONFIGURED
    ) {
      if (account.User.Policy.IsAdministrator === false) {
        throw new ApiError(403, ApiErrorCode.NotAdmin);
      }

      if (settings.main.mediaServerType === MediaServerType.NOT_CONFIGURED) {
        settings.main.mediaServerType = MediaServerType.JELLYFIN;
      }
      settings.main.jellyfinLoginEnabled = true;

      if (missingAdminUser) {
        logger.info(
          'Sign-in attempt from Jellyfin user; creating initial admin user for Seerr',
          { label: 'API', ip: req.ip, jellyfinUsername: account.User.Name }
        );

        user = new User({
          id: 1,
          email: body.email || account.User.Name,
          jellyfinUsername: account.User.Name,
          jellyfinUserId: account.User.Id,
          jellyfinDeviceId: deviceId,
          jellyfinAuthToken: account.AccessToken,
          permissions: Permission.ADMIN,
          userType: UserType.JELLYFIN,
        });
        user.avatar = getUserAvatarUrl(user, 'jellyfin');

        await userRepository.save(user);
        user.setDisplayName();
      } else {
        logger.info(
          'Sign-in attempt from Jellyfin user; editing admin user for Seerr',
          { label: 'API', ip: req.ip, jellyfinUsername: account.User.Name }
        );

        user = await userRepository.findOne({ where: { id: 1 } });
        if (!user) {
          throw new Error('Unable to find admin user to edit');
        }
        user.email = body.email || account.User.Name;
        user.jellyfinUsername = account.User.Name;
        user.jellyfinUserId = account.User.Id;
        user.jellyfinDeviceId = deviceId;
        user.jellyfinAuthToken = account.AccessToken;
        user.permissions = Permission.ADMIN;
        user.avatar = getUserAvatarUrl(user, 'jellyfin');
        user.userType = UserType.JELLYFIN;

        await userRepository.save(user);
        user.setDisplayName();
      }

      const jellyfinClient = JellyfinAPI.forJellyfin(
        jellyfinSettingsForLogin,
        account.AccessToken,
        deviceId
      );
      const apiKey = await jellyfinClient.createApiToken('Seerr');
      const serverName = await jellyfinserver.getServerName();

      settings.jellyfin.name = serverName;
      settings.jellyfin.serverId = account.User.ServerId;
      settings.jellyfin.ip = body.hostname ?? '';
      settings.jellyfin.port = body.port ?? 8096;
      settings.jellyfin.urlBase = body.urlBase ?? '';
      settings.jellyfin.useSsl = body.useSsl ?? false;
      settings.jellyfin.apiKey = apiKey;
      await settings.save();
      startJobs();
    } else if (account.User.Id === user?.jellyfinUserId) {
      logger.info('Found matching Jellyfin user; updating user with Jellyfin', {
        label: 'API',
        ip: req.ip,
        jellyfinUsername: account.User.Name,
      });
      user.avatar = getUserAvatarUrl(user, 'jellyfin');
      user.jellyfinUsername = account.User.Name;

      if (user.username === account.User.Name) {
        user.username = '';
      }

      await userRepository.save(user);
      user.setDisplayName();
    } else if (!settings.main.newPlexLogin) {
      logger.warn(
        'Failed sign-in attempt by unimported Jellyfin user with access to the media server',
        {
          label: 'API',
          ip: req.ip,
          jellyfinUserId: account.User.Id,
          jellyfinUsername: account.User.Name,
        }
      );
      return next({ status: 403, message: 'Access denied.' });
    } else if (!user) {
      logger.info(
        'Sign-in attempt from Jellyfin user with access to the media server; creating new Seerr user',
        { label: 'API', ip: req.ip, jellyfinUsername: account.User.Name }
      );

      user = new User({
        email: body.email,
        jellyfinUsername: account.User.Name,
        jellyfinUserId: account.User.Id,
        jellyfinDeviceId: deviceId,
        permissions: settings.main.defaultPermissions,
        userType: UserType.JELLYFIN,
      });
      user.avatar = getUserAvatarUrl(user, 'jellyfin');

      const passedExplicitPassword = body.password && body.password.length > 0;
      if (passedExplicitPassword) {
        await user.setPassword(body.password ?? '');
      }
      await userRepository.save(user);
    }

    if (user && user.jellyfinUserId) {
      try {
        const { changed } = await checkAvatarChanged(user);
        if (changed) {
          user.avatar = getUserAvatarUrl(user, 'jellyfin');
          await userRepository.save(user);
        }
      } catch (error) {
        logger.error('Error handling avatar during login', {
          label: 'Auth',
          errorMessage: error.message,
        });
      }
    }

    if (req.session) {
      req.session.userId = user?.id;
    }

    return res.status(200).json(user?.filter() ?? {});
  } catch (e) {
    switch (e.errorCode) {
      case ApiErrorCode.InvalidUrl:
        logger.error(
          'The provided Jellyfin URL is invalid or the server is not reachable.',
          {
            label: 'Auth',
            error: e.errorCode,
            status: e.statusCode,
            hostname: getHostname({
              useSsl: body.useSsl,
              ip: body.hostname,
              port: body.port,
              urlBase: body.urlBase,
            }),
          }
        );
        return next({ status: e.statusCode, message: e.errorCode });

      case ApiErrorCode.InvalidCredentials:
        logger.warn(
          'Failed sign-in attempt from user with incorrect Jellyfin credentials',
          {
            label: 'Auth',
            account: {
              ip: req.ip,
              email: body.username,
              password: '__REDACTED__',
            },
          }
        );
        return next({ status: e.statusCode, message: e.errorCode });

      case ApiErrorCode.NotAdmin:
        logger.warn(
          'Failed sign-in attempt from user without admin permissions',
          {
            label: 'Auth',
            account: { ip: req.ip, email: body.username },
          }
        );
        return next({ status: e.statusCode, message: e.errorCode });

      case ApiErrorCode.NoAdminUser:
        logger.warn(
          'Failed sign-in attempt from user without admin permissions and no admin user exists',
          { label: 'Auth', account: { ip: req.ip, email: body.username } }
        );
        return next({ status: e.statusCode, message: e.errorCode });

      default:
        logger.error(e.message, { label: 'Auth' });
        return next({ status: 500, message: 'Something went wrong.' });
    }
  }
});

authRoutes.post('/emby', async (req, res, next) => {
  const settings = getSettings();
  const userRepository = getRepository(User);
  const body = req.body as {
    username?: string;
    password?: string;
    hostname?: string;
    port?: number;
    urlBase?: string;
    useSsl?: boolean;
    email?: string;
  };

  const hasAnyUsers = (await userRepository.count()) > 0;

  if (!settings.main.embyLoginEnabled && hasAnyUsers) {
    return res.status(401).json({ error: 'Emby login is disabled' });
  }

  if (!body.username) {
    return res.status(500).json({ error: 'You must provide an username' });
  } else if (settings.emby.ip !== '' && body.hostname) {
    return res.status(500).json({ error: 'Emby hostname already configured' });
  } else if (settings.emby.ip === '' && !body.hostname) {
    return res.status(500).json({ error: 'No hostname provided.' });
  }

  try {
    // Build an EmbySettings-shaped object from saved settings, or from
    // body fields when this is a fresh setup with no saved hostname yet.
    const embySettingsForLogin =
      settings.emby.ip !== ''
        ? settings.emby
        : {
            ...settings.emby,
            ip: body.hostname ?? '',
            port: body.port ?? 8096,
            useSsl: body.useSsl,
            urlBase: body.urlBase,
          };
    // Try to find deviceId that corresponds to emby user, else generate a new one
    let user = await userRepository.findOne({
      where: { embyUsername: body.username },
      select: { id: true, embyDeviceId: true },
    });

    let deviceId = 'BOT_seerr';
    if (user && user.id === 1) {
      deviceId = 'BOT_seerr';
    } else if (user && user.embyDeviceId) {
      deviceId = user.embyDeviceId;
    } else if (body.username) {
      deviceId = Buffer.from(`BOT_seerr_${body.username}`).toString('base64');
    }

    const embyserver = JellyfinAPI.forEmby(
      embySettingsForLogin,
      undefined,
      deviceId
    );
    const clientIp = resolveClientIp(req.ip);

    const account = await embyserver.login(
      body.username,
      body.password,
      clientIp
    );

    // Brand-mismatch detection: the auth succeeded but the server is actually Jellyfin.
    // Return 400 so the frontend can silently re-dispatch to /auth/jellyfin.
    const detectedBrandEmby = await embyserver.getServerProductName();
    if (detectedBrandEmby === 'jellyfin') {
      return res.status(400).json({
        message:
          'Server is actually Jellyfin. Re-dispatching to /auth/jellyfin.',
        errorCode: ApiErrorCode.ServerBrandMismatch,
        detectedBrand: 'jellyfin',
      });
    }
    if (detectedBrandEmby === null) {
      logger.warn(
        'Could not determine server brand after Emby auth; proceeding as Emby.',
        { label: 'Auth', ip: req.ip }
      );
    }

    // Look up by embyUserId first
    // User-accepted: silent email-match merge enables one seerr account to hold Plex + Jellyfin + Emby identities.
    user = await userRepository.findOne({
      where: { embyUserId: account.User.Id },
    });

    // Email-fallback merge: if no embyUserId match, look up by email
    if (!user && body.email) {
      const emailMatchedUser = await userRepository.findOne({
        where: { email: body.email.toLowerCase() },
      });
      if (emailMatchedUser) {
        if (!emailMatchedUser.embyUserId) {
          // Silent merge: add emby* columns to the existing row without touching other providers
          logger.info(
            'Auto-merged Emby login into existing user via email match',
            { userId: emailMatchedUser.id, email: emailMatchedUser.email }
          );
          emailMatchedUser.embyUserId = account.User.Id;
          emailMatchedUser.embyUsername = account.User.Name;
          emailMatchedUser.embyDeviceId = deviceId;
          emailMatchedUser.embyAuthToken = account.AccessToken;
          // userType is preserved — it records the originating provider, not an exclusion
          await userRepository.save(emailMatchedUser);
          emailMatchedUser.setDisplayName();
          user = emailMatchedUser;
        } else if (emailMatchedUser.embyUserId !== account.User.Id) {
          logger.warn(
            'Emby login rejected: email matches a different Emby account already linked',
            {
              email: emailMatchedUser.email,
              existingEmbyUserId: emailMatchedUser.embyUserId,
              incomingEmbyUserId: account.User.Id,
            }
          );
          return res.status(409).json({
            message: 'Email matches a different Emby account already linked.',
          });
        }
        // else: same embyUserId — fall through normally
      }
    }

    const missingAdminUser = !user && !hasAnyUsers;
    if (
      missingAdminUser ||
      settings.main.mediaServerType === MediaServerType.NOT_CONFIGURED
    ) {
      if (account.User.Policy.IsAdministrator === false) {
        throw new ApiError(403, ApiErrorCode.NotAdmin);
      }

      if (settings.main.mediaServerType === MediaServerType.NOT_CONFIGURED) {
        settings.main.mediaServerType = MediaServerType.EMBY;
      }
      settings.main.embyLoginEnabled = true;

      if (missingAdminUser) {
        logger.info(
          'Sign-in attempt from Emby user; creating initial admin user for Seerr',
          { label: 'API', ip: req.ip, embyUsername: account.User.Name }
        );

        user = new User({
          id: 1,
          email: body.email || account.User.Name,
          embyUsername: account.User.Name,
          embyUserId: account.User.Id,
          embyDeviceId: deviceId,
          embyAuthToken: account.AccessToken,
          permissions: Permission.ADMIN,
          avatar: '',
          userType: UserType.EMBY,
        });
        user.avatar = getUserAvatarUrl(user, 'emby');

        await userRepository.save(user);
        user.setDisplayName();
      } else {
        logger.info(
          'Sign-in attempt from Emby user; editing admin user for Seerr',
          { label: 'API', ip: req.ip, embyUsername: account.User.Name }
        );

        user = await userRepository.findOne({ where: { id: 1 } });
        if (!user) {
          throw new Error('Unable to find admin user to edit');
        }
        user.email = body.email || account.User.Name;
        user.embyUsername = account.User.Name;
        user.embyUserId = account.User.Id;
        user.embyDeviceId = deviceId;
        user.embyAuthToken = account.AccessToken;
        user.permissions = Permission.ADMIN;
        user.userType = UserType.EMBY;
        user.avatar = getUserAvatarUrl(user, 'emby');

        await userRepository.save(user);
        user.setDisplayName();
      }

      const embyClient = JellyfinAPI.forEmby(
        embySettingsForLogin,
        account.AccessToken,
        deviceId
      );
      const apiKey = await embyClient.createApiToken('Seerr');
      const serverName = await embyserver.getServerName();

      settings.emby.name = serverName;
      settings.emby.serverId = account.User.ServerId;
      settings.emby.ip = body.hostname ?? '';
      settings.emby.port = body.port ?? 8096;
      settings.emby.urlBase = body.urlBase ?? '';
      settings.emby.useSsl = body.useSsl ?? false;
      settings.emby.apiKey = apiKey;
      await settings.save();
      startJobs();
    } else if (account.User.Id === user?.embyUserId) {
      logger.info('Found matching Emby user; updating user with Emby', {
        label: 'API',
        ip: req.ip,
        embyUsername: account.User.Name,
      });
      user.embyUsername = account.User.Name;
      user.embyAuthToken = account.AccessToken;
      user.embyDeviceId = deviceId;
      user.avatar = getUserAvatarUrl(user, 'emby');

      if (user.username === account.User.Name) {
        user.username = '';
      }

      await userRepository.save(user);
      user.setDisplayName();
    } else if (!settings.main.newPlexLogin) {
      logger.warn(
        'Failed sign-in attempt by unimported Emby user with access to the media server',
        {
          label: 'API',
          ip: req.ip,
          embyUserId: account.User.Id,
          embyUsername: account.User.Name,
        }
      );
      return next({ status: 403, message: 'Access denied.' });
    } else if (!user) {
      logger.info(
        'Sign-in attempt from Emby user with access to the media server; creating new Seerr user',
        { label: 'API', ip: req.ip, embyUsername: account.User.Name }
      );

      user = new User({
        email: body.email || account.User.Name,
        embyUsername: account.User.Name,
        embyUserId: account.User.Id,
        embyDeviceId: deviceId,
        embyAuthToken: account.AccessToken,
        permissions: settings.main.defaultPermissions,
        avatar: '',
        userType: UserType.EMBY,
      });
      user.avatar = getUserAvatarUrl(user, 'emby');

      const passedExplicitPassword = body.password && body.password.length > 0;
      if (passedExplicitPassword) {
        await user.setPassword(body.password ?? '');
      }
      await userRepository.save(user);
    }

    if (user && user.embyUserId) {
      try {
        const { changed } = await checkAvatarChanged(user, 'emby');
        if (changed) {
          user.avatar = getUserAvatarUrl(user, 'emby');
          await userRepository.save(user);
        }
      } catch (error) {
        logger.error('Error handling avatar during login', {
          label: 'Auth',
          errorMessage: error.message,
        });
      }
    }

    if (req.session) {
      req.session.userId = user?.id;
    }

    return res.status(200).json(user?.filter() ?? {});
  } catch (e) {
    switch (e.errorCode) {
      case ApiErrorCode.InvalidUrl:
        logger.error(
          'The provided Emby URL is invalid or the server is not reachable.',
          {
            label: 'Auth',
            error: e.errorCode,
            status: e.statusCode,
            hostname: getHostname({
              useSsl: body.useSsl,
              ip: body.hostname,
              port: body.port,
              urlBase: body.urlBase,
            }),
          }
        );
        return next({ status: e.statusCode, message: e.errorCode });

      case ApiErrorCode.InvalidCredentials:
        logger.warn(
          'Failed sign-in attempt from user with incorrect Emby credentials',
          {
            label: 'Auth',
            account: {
              ip: req.ip,
              email: body.username,
              password: '__REDACTED__',
            },
          }
        );
        return next({ status: e.statusCode, message: e.errorCode });

      case ApiErrorCode.NotAdmin:
        logger.warn(
          'Failed sign-in attempt from Emby user without admin permissions',
          {
            label: 'Auth',
            account: { ip: req.ip, email: body.username },
          }
        );
        return next({ status: e.statusCode, message: e.errorCode });

      case ApiErrorCode.NoAdminUser:
        logger.warn(
          'Failed sign-in attempt from Emby user without admin permissions and no admin user exists',
          { label: 'Auth', account: { ip: req.ip, email: body.username } }
        );
        return next({ status: e.statusCode, message: e.errorCode });

      default:
        logger.error(e.message, { label: 'Auth' });
        return next({ status: 500, message: 'Something went wrong.' });
    }
  }
});

authRoutes.post('/local', async (req, res, next) => {
  const settings = getSettings();
  const userRepository = getRepository(User);
  const body = req.body as { email?: string; password?: string };

  if (!settings.main.localLogin) {
    return res.status(500).json({ error: 'Password sign-in is disabled.' });
  } else if (!body.email || !body.password) {
    return res.status(500).json({
      error: 'You must provide both an email address and a password.',
    });
  }
  try {
    const user = await userRepository
      .createQueryBuilder('user')
      .select(['user.id', 'user.email', 'user.password', 'user.plexId'])
      .where('user.email = :email', { email: body.email.toLowerCase() })
      .getOne();

    if (!user || !(await user.passwordMatch(body.password))) {
      logger.warn('Failed sign-in attempt using invalid Seerr password', {
        label: 'API',
        ip: req.ip,
        email: body.email,
        userId: user?.id,
      });
      return next({
        status: 403,
        message: 'Access denied.',
      });
    }

    // Set logged in session
    if (user && req.session) {
      req.session.userId = user.id;
    }

    return res.status(200).json(user?.filter() ?? {});
  } catch (e) {
    logger.error('Something went wrong authenticating with Seerr password', {
      label: 'API',
      errorMessage: e.message,
      ip: req.ip,
      email: body.email,
    });
    return next({
      status: 500,
      message: 'Unable to authenticate.',
    });
  }
});

authRoutes.post('/logout', async (req, res, next) => {
  try {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(200).json({ status: 'ok' });
    }

    const settings = getSettings();
    const user = await getRepository(User)
      .createQueryBuilder('user')
      .addSelect([
        'user.jellyfinUserId',
        'user.jellyfinDeviceId',
        'user.embyUserId',
        'user.embyDeviceId',
      ])
      .where('user.id = :id', { id: userId })
      .getOne();

    const deleteDevice = async ({
      provider,
      deviceId,
      userProviderId,
      token,
      baseUrl,
      version,
    }: {
      provider: 'Jellyfin' | 'Emby';
      deviceId?: string | null;
      userProviderId?: string | null;
      token: string;
      baseUrl: string;
      version: string;
    }) => {
      if (!deviceId || !userProviderId || !token) {
        return;
      }

      try {
        await axios.delete(`${baseUrl}/Devices`, {
          params: { Id: deviceId },
          headers: {
            'X-Emby-Authorization': `MediaBrowser Client="Seerr", Device="Seerr", DeviceId="seerr", Version="${version}", Token="${token}"`,
          },
        });
      } catch (error) {
        logger.error(`Failed to delete ${provider} device`, {
          label: 'Auth',
          error: error instanceof Error ? error.message : 'Unknown error',
          userId: user?.id,
          providerUserId: userProviderId,
        });
      }
    };

    if (user) {
      await deleteDevice({
        provider: 'Jellyfin',
        deviceId: user.jellyfinDeviceId,
        userProviderId: user.jellyfinUserId,
        token: settings.jellyfin.apiKey,
        baseUrl: getHostname(settings.jellyfin),
        version: getAppVersion(),
      });
      await deleteDevice({
        provider: 'Emby',
        deviceId: user.embyDeviceId,
        userProviderId: user.embyUserId,
        token: settings.emby.apiKey,
        baseUrl: getHostname(settings.emby),
        version: '1.0.0',
      });
    }

    req.session?.destroy((err: Error | null) => {
      if (err) {
        logger.error('Failed to destroy session', {
          label: 'Auth',
          error: err.message,
          userId,
        });
        return next({ status: 500, message: 'Failed to destroy session.' });
      }
      logger.debug('Successfully logged out user', {
        label: 'Auth',
        userId,
      });
      res.status(200).json({ status: 'ok' });
    });
  } catch (error) {
    logger.error('Error during logout process', {
      label: 'Auth',
      error: error instanceof Error ? error.message : 'Unknown error',
      userId: req.session?.userId,
    });
    next({ status: 500, message: 'Error during logout process.' });
  }
});

authRoutes.post('/reset-password', async (req, res, next) => {
  const userRepository = getRepository(User);
  const body = req.body as { email?: string };

  if (!body.email) {
    return next({
      status: 500,
      message: 'Email address required.',
    });
  }

  const user = await userRepository
    .createQueryBuilder('user')
    .where('user.email = :email', { email: body.email.toLowerCase() })
    .getOne();

  if (user) {
    await user.resetPassword();
    await userRepository.save(user);
    logger.info('Successfully sent password reset link', {
      label: 'API',
      ip: req.ip,
      email: body.email,
    });
  } else {
    logger.error('Something went wrong sending password reset link', {
      label: 'API',
      ip: req.ip,
      email: body.email,
    });
  }

  return res.status(200).json({ status: 'ok' });
});

authRoutes.post('/reset-password/:guid', async (req, res, next) => {
  const userRepository = getRepository(User);

  if (!req.body.password || req.body.password?.length < 8) {
    logger.warn('Failed password reset attempt using invalid new password', {
      label: 'API',
      ip: req.ip,
      guid: req.params.guid,
    });
    return next({
      status: 500,
      message: 'Password must be at least 8 characters long.',
    });
  }

  const user = await userRepository.findOne({
    where: { resetPasswordGuid: req.params.guid },
  });

  if (!user) {
    logger.warn('Failed password reset attempt using invalid recovery link', {
      label: 'API',
      ip: req.ip,
      guid: req.params.guid,
    });
    return next({
      status: 500,
      message: 'Invalid password reset link.',
    });
  }

  if (
    !user.recoveryLinkExpirationDate ||
    user.recoveryLinkExpirationDate <= new Date()
  ) {
    logger.warn('Failed password reset attempt using expired recovery link', {
      label: 'API',
      ip: req.ip,
      guid: req.params.guid,
      email: user.email,
    });
    return next({
      status: 500,
      message: 'Invalid password reset link.',
    });
  }
  user.recoveryLinkExpirationDate = null;
  await user.setPassword(req.body.password);
  await userRepository.save(user);
  logger.info('Successfully reset password', {
    label: 'API',
    ip: req.ip,
    guid: req.params.guid,
    email: user.email,
  });

  return res.status(200).json({ status: 'ok' });
});

export default authRoutes;
