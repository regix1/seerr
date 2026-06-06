import JellyfinAPI from '@server/api/jellyfin';
import PlexTvAPI from '@server/api/plextv';
import TautulliAPI from '@server/api/tautulli';
import { MediaType } from '@server/constants/media';
import { UserType } from '@server/constants/user';
import dataSource, { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { UserPushSubscription } from '@server/entity/UserPushSubscription';
import { Watchlist } from '@server/entity/Watchlist';
import type { WatchlistResponse } from '@server/interfaces/api/discoverInterfaces';
import type {
  QuotaResponse,
  UserRequestsResponse,
  UserResultsResponse,
  UserWatchDataResponse,
} from '@server/interfaces/api/userInterfaces';
import {
  Permission,
  Permission2,
  hasPermission,
} from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { normalizeJellyfinGuid } from '@server/utils/jellyfin';
import { isOwnProfileOrAdmin } from '@server/utils/profileMiddleware';
import { Router } from 'express';
import gravatarUrl from 'gravatar-url';
import { findIndex, sortBy } from 'lodash';
import type { EntityManager } from 'typeorm';
import { In, Not } from 'typeorm';
import userSettingsRoutes from './usersettings';

const router = Router();

/**
 * Server-side requester redaction (criterion 32). When a viewer lacks
 * VIEW_REQUESTER / MANAGE_REQUESTS, strip `requestedBy` from
 * any request rows that don't belong to them. Owner of a row always sees
 * their own attribution.
 */
const canViewRequester = (user?: User): boolean => {
  return (
    !!user &&
    user.hasPermission(
      [Permission2.VIEW_REQUESTER, Permission.MANAGE_REQUESTS],
      { type: 'or' }
    )
  );
};

const redactRequester = <T extends { requestedBy?: User | null }>(
  viewer: User | undefined,
  request: T
): T => {
  if (!request || !request.requestedBy) {
    return request;
  }
  if (viewer && viewer.id === request.requestedBy.id) {
    return request;
  }
  if (canViewRequester(viewer)) {
    return request;
  }
  const cloned = { ...request } as T & { requestedBy?: User | null };
  delete cloned.requestedBy;
  return cloned;
};

router.get('/', async (req, res, next) => {
  try {
    const includeIds = [
      ...new Set(
        req.query.includeIds ? req.query.includeIds.toString().split(',') : []
      ),
    ];
    const pageSize = req.query.take
      ? Number(req.query.take)
      : Math.max(10, includeIds.length);
    const skip = req.query.skip ? Number(req.query.skip) : 0;
    const q = req.query.q ? req.query.q.toString().toLowerCase() : '';
    const sortParam = req.query.sort ? req.query.sort.toString() : undefined;
    const sortDirectionQuery = req.query.sortDirection
      ? req.query.sortDirection.toString().toLowerCase()
      : undefined;

    let sortDirection: 'ASC' | 'DESC';
    if (sortDirectionQuery === 'asc') {
      sortDirection = 'ASC';
    } else if (sortDirectionQuery === 'desc') {
      sortDirection = 'DESC';
    } else {
      switch (sortParam) {
        case 'displayname':
          sortDirection = 'ASC';
          break;
        case 'requests':
        case 'updated':
          sortDirection = 'DESC';
          break;
        case 'created':
        case 'usertype':
        case 'role':
        case undefined:
        default:
          sortDirection = 'ASC';
          break;
      }
    }

    let query = getRepository(User).createQueryBuilder('user');

    if (q) {
      query = query.where(
        'LOWER(user.username) LIKE :q OR LOWER(user.email) LIKE :q OR LOWER(user.plexUsername) LIKE :q OR LOWER(user.jellyfinUsername) LIKE :q OR LOWER(user.embyUsername) LIKE :q',
        { q: `%${q}%` }
      );
    }

    if (includeIds.length > 0) {
      query.andWhereInIds(includeIds);
    }

    // Filter on column presence (not userType) so triple-linked users match every provider
    // they hold credentials for. Per Phase 14 acceptance criterion #25.
    const providerFilter = req.query.filter
      ? req.query.filter.toString()
      : undefined;
    if (providerFilter === 'plex') {
      query = query.andWhere('user.plexId IS NOT NULL');
    } else if (providerFilter === 'jellyfin') {
      query = query.andWhere('user.jellyfinUserId IS NOT NULL');
    } else if (providerFilter === 'emby') {
      query = query.andWhere('user.embyUserId IS NOT NULL');
    }

    switch (sortParam) {
      case 'created':
        query = query.orderBy('user.createdAt', sortDirection);
        break;
      case 'updated':
        query = query.orderBy('user.updatedAt', sortDirection);
        break;
      case 'displayname':
        query = query
          .addSelect(
            `CASE WHEN (user.username IS NULL OR user.username = '') THEN (
                CASE WHEN (user.plexUsername IS NULL OR user.plexUsername = '') THEN (
                  CASE WHEN (user.jellyfinUsername IS NULL OR user.jellyfinUsername = '') THEN (
                    CASE WHEN (user.embyUsername IS NULL OR user.embyUsername = '') THEN
                      "user"."email"
                    ELSE
                      LOWER(user.embyUsername)
                    END)
                  ELSE
                    LOWER(user.jellyfinUsername)
                  END)
                ELSE
                  LOWER(user.plexUsername)
                END)
              ELSE
                LOWER(user.username)
              END`,
            'displayname_sort_key'
          )
          .orderBy('displayname_sort_key', sortDirection);
        break;
      case 'requests':
        query = query
          .addSelect((subQuery) => {
            return subQuery
              .select('COUNT(request.id)', 'request_count')
              .from(MediaRequest, 'request')
              .where('request.requestedBy.id = user.id');
          }, 'request_count')
          .orderBy('request_count', sortDirection);
        break;
      case 'usertype':
        query = query.orderBy('user.userType', sortDirection);
        break;
      case 'role':
        query = query
          .addSelect(
            `CASE
              WHEN user.id = 1 THEN 0
              WHEN (user.permissions & ${Permission.ADMIN}) != 0 THEN 1
              ELSE 2
            END`,
            'role_sort_key'
          )
          .orderBy('role_sort_key', sortDirection);
        break;
      default:
        query = query.orderBy('user.id', sortDirection);
        break;
    }

    const [users, userCount] = await query
      .take(pageSize)
      .skip(skip)
      .distinct(true)
      .getManyAndCount();

    return res.status(200).json({
      pageInfo: {
        pages: Math.ceil(userCount / pageSize),
        pageSize,
        results: userCount,
        page: Math.ceil(skip / pageSize) + 1,
      },
      results: User.filterMany(
        users,
        req.user?.hasPermission(Permission.MANAGE_USERS)
      ),
    } as UserResultsResponse);
  } catch (e) {
    next({ status: 500, message: e.message });
  }
});

router.post(
  '/',
  // was Permission.MANAGE_USERS — re-pointed to granular MANAGE_USERS_CREATE
  isAuthenticated(Permission2.MANAGE_USERS_CREATE),
  async (req, res, next) => {
    try {
      const settings = getSettings();

      const body = req.body;
      const email = body.email || body.username;
      const userRepository = getRepository(User);

      const existingUser = await userRepository
        .createQueryBuilder('user')
        .where('user.email = :email', {
          email: email.toLowerCase(),
        })
        .getOne();

      if (existingUser) {
        return next({
          status: 409,
          message: 'User already exists with submitted email.',
          errors: ['USER_EXISTS'],
        });
      }

      const passedExplicitPassword = body.password && body.password.length > 0;
      const avatar = gravatarUrl(email, { default: 'mm', size: 200 });

      if (
        !passedExplicitPassword &&
        !settings.notifications.agents.email.enabled
      ) {
        throw new Error('Email notifications must be enabled');
      }

      const user = new User({
        email,
        avatar: body.avatar ?? avatar,
        username: body.username,
        password: body.password,
        permissions: settings.main.defaultPermissions,
        plexToken: '',
        userType: UserType.LOCAL,
      });

      if (passedExplicitPassword) {
        await user?.setPassword(body.password);
      } else {
        await user?.generatePassword();
      }

      await userRepository.save(user);
      return res.status(201).json(user.filter());
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

router.post<
  never,
  unknown,
  {
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent: string;
  }
>('/registerPushSubscription', async (req, res, next) => {
  try {
    // This prevents race conditions where two requests both pass the checks
    await dataSource.transaction(
      async (transactionalEntityManager: EntityManager) => {
        const transactionalRepo =
          transactionalEntityManager.getRepository(UserPushSubscription);

        // Check for existing subscription by auth or endpoint within transaction
        const existingSubscription = await transactionalRepo.findOne({
          relations: { user: true },
          where: [
            { auth: req.body.auth, user: { id: req.user?.id } },
            { endpoint: req.body.endpoint, user: { id: req.user?.id } },
          ],
        });

        if (existingSubscription) {
          // If endpoint matches but auth is different, update with new keys (iOS refresh case)
          if (
            existingSubscription.endpoint === req.body.endpoint &&
            existingSubscription.auth !== req.body.auth
          ) {
            existingSubscription.auth = req.body.auth;
            existingSubscription.p256dh = req.body.p256dh;
            existingSubscription.userAgent = req.body.userAgent;

            await transactionalRepo.save(existingSubscription);

            logger.debug(
              'Updated existing push subscription with new keys for same endpoint.',
              { label: 'API' }
            );
            return;
          }

          logger.debug(
            'Duplicate subscription detected. Skipping registration.',
            { label: 'API' }
          );
          return;
        }

        // Clean up old subscriptions from the same device (userAgent) for this user
        // iOS can silently refresh endpoints, leaving stale subscriptions in the database
        // Only clean up if we're creating a new subscription (not updating an existing one)
        if (req.body.userAgent) {
          const staleSubscriptions = await transactionalRepo.find({
            relations: { user: true },
            where: {
              userAgent: req.body.userAgent,
              user: { id: req.user?.id },
              // Only remove subscriptions with different endpoints (stale ones)
              // Keep subscriptions that might be from different browsers/tabs
              endpoint: Not(req.body.endpoint),
            },
          });

          if (staleSubscriptions.length > 0) {
            await transactionalRepo.remove(staleSubscriptions);
            logger.debug(
              `Removed ${staleSubscriptions.length} stale push subscription(s) from same device.`,
              { label: 'API' }
            );
          }
        }

        const userPushSubscription = new UserPushSubscription({
          auth: req.body.auth,
          endpoint: req.body.endpoint,
          p256dh: req.body.p256dh,
          userAgent: req.body.userAgent,
          user: req.user,
        });

        await transactionalRepo.save(userPushSubscription);
      }
    );

    return res.status(204).send();
  } catch {
    logger.error('Failed to register user push subscription', {
      label: 'API',
    });
    next({ status: 500, message: 'Failed to register subscription.' });
  }
});

router.get<{ id: string }>(
  '/:id/pushSubscriptions',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    try {
      const userPushSubRepository = getRepository(UserPushSubscription);

      const userPushSubs = await userPushSubRepository.find({
        relations: { user: true },
        where: { user: { id: Number(req.params.id) } },
      });

      return res.status(200).json(userPushSubs);
    } catch {
      next({ status: 404, message: 'User subscriptions not found.' });
    }
  }
);

router.get<{ id: string; endpoint: string }>(
  '/:id/pushSubscription/:endpoint',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    try {
      const userPushSubRepository = getRepository(UserPushSubscription);

      const userPushSub = await userPushSubRepository.findOneOrFail({
        relations: {
          user: true,
        },
        where: {
          user: { id: Number(req.params.id) },
          endpoint: req.params.endpoint,
        },
      });

      return res.status(200).json(userPushSub);
    } catch {
      next({ status: 404, message: 'User subscription not found.' });
    }
  }
);

router.delete<{ id: string; endpoint: string }>(
  '/:id/pushSubscription/:endpoint',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    try {
      const userPushSubRepository = getRepository(UserPushSubscription);

      const userPushSub = await userPushSubRepository.findOne({
        relations: { user: true },
        where: {
          user: { id: Number(req.params.id) },
          endpoint: req.params.endpoint,
        },
      });

      // If not found, just return 204 to prevent push disable failure
      // (rare scenario where user push sub does not exist)
      if (!userPushSub) {
        return res.status(204).send();
      }

      await userPushSubRepository.remove(userPushSub);
      return res.status(204).send();
    } catch (e) {
      logger.error('Something went wrong deleting the user push subcription', {
        label: 'API',
        endpoint: req.params.endpoint,
        errorMessage: e.message,
      });
      return next({
        status: 500,
        message: 'User push subcription not found',
      });
    }
  }
);

router.get<{ id: string }>('/:id', async (req, res, next) => {
  try {
    const userRepository = getRepository(User);
    const user = await userRepository.findOneOrFail({
      where: { id: Number(req.params.id) },
    });

    const isOwnProfile = req.user?.id === user.id;
    const isAdmin = req.user?.hasPermission(Permission.MANAGE_USERS);

    return res.status(200).json(user.filter(isOwnProfile || isAdmin));
  } catch {
    next({ status: 404, message: 'User not found.' });
  }
});

router.get<{ jellyfinUserId: string }>(
  '/jellyfin/:jellyfinUserId',
  async (req, res, next) => {
    try {
      const userRepository = getRepository(User);

      const jellyfinUserId = normalizeJellyfinGuid(req.params.jellyfinUserId);
      if (!jellyfinUserId) {
        return next({ status: 400, message: 'Invalid Jellyfin User ID.' });
      }

      const user = await userRepository.findOneOrFail({
        where: { jellyfinUserId },
      });

      return res
        .status(200)
        .json(user.filter(req.user?.hasPermission(Permission.MANAGE_USERS)));
    } catch {
      next({ status: 404, message: 'User not found.' });
    }
  }
);

router.use('/:id/settings', userSettingsRoutes);

router.get<{ id: string }, UserRequestsResponse>(
  '/:id/requests',
  async (req, res, next) => {
    const pageSize = req.query.take ? Number(req.query.take) : 20;
    const skip = req.query.skip ? Number(req.query.skip) : 0;

    try {
      const user = await getRepository(User).findOne({
        where: { id: Number(req.params.id) },
      });

      if (!user) {
        return next({ status: 404, message: 'User not found.' });
      }

      if (
        user.id !== req.user?.id &&
        !req.user?.hasPermission(
          [Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW],
          { type: 'or' }
        )
      ) {
        return next({
          status: 403,
          message: "You do not have permission to view this user's requests.",
        });
      }

      const [requests, requestCount] = await getRepository(MediaRequest)
        .createQueryBuilder('request')
        .leftJoinAndSelect('request.media', 'media')
        .leftJoinAndSelect('request.seasons', 'seasons')
        .leftJoinAndSelect('request.modifiedBy', 'modifiedBy')
        .leftJoinAndSelect('request.requestedBy', 'requestedBy')
        .andWhere('requestedBy.id = :id', {
          id: user.id,
        })
        .orderBy('request.id', 'DESC')
        .take(pageSize)
        .skip(skip)
        .getManyAndCount();

      // Redact requester for viewers without VIEW_REQUESTER on rows they
      // do not own (criterion 32).
      const safeRequests = requests.map((r) => redactRequester(req.user, r));

      return res.status(200).json({
        pageInfo: {
          pages: Math.ceil(requestCount / pageSize),
          pageSize,
          results: requestCount,
          page: Math.ceil(skip / pageSize) + 1,
        },
        results: safeRequests,
      });
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

export const canMakePermissionsChange = (
  permissions: number,
  user?: User
): boolean =>
  // Only let the owner grant admin privileges. ADMIN lives on the legacy
  // bitmask only, so we pass `0` as the granular bitmask — the new
  // `hasPermission` signature requires both columns explicitly.
  !(hasPermission(Permission.ADMIN, permissions, 0) && user?.id !== 1);

router.put<
  Record<string, never>,
  Partial<User>[],
  { ids: string[]; permissions: number }
>(
  '/',
  // was Permission.MANAGE_USERS — re-pointed to granular MANAGE_USERS_PERMISSIONS
  // (this bulk endpoint mutates permissions; pure profile edits use PUT /:id)
  isAuthenticated(Permission2.MANAGE_USERS_PERMISSIONS),
  async (req, res, next) => {
    try {
      const isOwner = req.user?.id === 1;

      if (!canMakePermissionsChange(req.body.permissions, req.user)) {
        return next({
          status: 403,
          message: 'You do not have permission to grant this level of access',
        });
      }

      const userRepository = getRepository(User);

      const users: User[] = await userRepository.find({
        where: {
          id: In(
            isOwner
              ? req.body.ids
              : req.body.ids.filter((id) => Number(id) !== 1)
          ),
        },
      });

      const updatedUsers = await Promise.all(
        users.map(async (user) => {
          return userRepository.save(<User>{
            ...user,
            ...{ permissions: req.body.permissions },
          });
        })
      );

      return res.status(200).json(updatedUsers);
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

router.put<{ id: string }>(
  '/:id',
  // was Permission.MANAGE_USERS — re-pointed: edits to permissions need
  // MANAGE_USERS_PERMISSIONS, plain profile field edits need MANAGE_USERS_EDIT.
  // The combined OR keeps the umbrella holders working while letting an EDIT-only
  // operator change usernames; the inner canMakePermissionsChange() still gates
  // permission elevation.
  isAuthenticated(
    [Permission2.MANAGE_USERS_EDIT, Permission2.MANAGE_USERS_PERMISSIONS],
    { type: 'or' }
  ),
  async (req, res, next) => {
    try {
      const userRepository = getRepository(User);

      const user = await userRepository.findOneOrFail({
        where: { id: Number(req.params.id) },
      });

      // Only let the owner user modify themselves
      if (user.id === 1 && req.user?.id !== 1) {
        return next({
          status: 403,
          message: 'You do not have permission to modify this user',
        });
      }

      // Inner gate: changing the `permissions` field requires the granular
      // MANAGE_USERS_PERMISSIONS bit. EDIT-only operators may patch profile
      // fields (username) but cannot mutate access levels.
      const isPermissionChange =
        typeof req.body.permissions === 'number' &&
        req.body.permissions !== user.permissions;
      if (
        isPermissionChange &&
        !req.user?.hasPermission(Permission2.MANAGE_USERS_PERMISSIONS)
      ) {
        return next({
          status: 403,
          message: 'You do not have permission to modify user permissions.',
        });
      }

      if (!canMakePermissionsChange(req.body.permissions, req.user)) {
        return next({
          status: 403,
          message: 'You do not have permission to grant this level of access',
        });
      }

      Object.assign(user, {
        username: req.body.username,
        permissions: req.body.permissions,
      });

      await userRepository.save(user);

      return res.status(200).json(user.filter());
    } catch {
      next({ status: 404, message: 'User not found.' });
    }
  }
);

router.delete<{ id: string }>(
  '/:id',
  // was Permission.MANAGE_USERS — re-pointed to granular MANAGE_USERS_DELETE
  isAuthenticated(Permission2.MANAGE_USERS_DELETE),
  async (req, res, next) => {
    try {
      const userRepository = getRepository(User);

      const user = await userRepository.findOne({
        where: { id: Number(req.params.id) },
        relations: { requests: true },
      });

      if (!user) {
        return next({ status: 404, message: 'User not found.' });
      }

      if (user.id === 1) {
        return next({
          status: 405,
          message: 'This account cannot be deleted.',
        });
      }

      if (user.hasPermission(Permission.ADMIN) && req.user?.id !== 1) {
        return next({
          status: 405,
          message: 'You cannot delete users with administrative privileges.',
        });
      }

      const requestRepository = getRepository(MediaRequest);

      /**
       * Requests are usually deleted through a cascade constraint. Those however, do
       * not trigger the removal event so listeners to not run and the parent Media
       * will not be updated back to unknown for titles that were still pending. So
       * we manually remove all requests from the user here so the parent media's
       * properly reflect the change.
       */
      await requestRepository.remove(user.requests, {
        /**
         * Break-up into groups of 1000 requests to be removed at a time.
         * Necessary for users with >1000 requests, else an SQLite 'Expression tree is too large' error occurs.
         * https://typeorm.io/repository-api#additional-options
         */
        chunk: user.requests.length / 1000,
      });

      await userRepository.delete(user.id);
      return res.status(200).json(user.filter());
    } catch (e) {
      logger.error('Something went wrong deleting a user', {
        label: 'API',
        userId: req.params.id,
        errorMessage: e.message,
      });
      return next({
        status: 500,
        message: 'Something went wrong deleting the user',
      });
    }
  }
);

router.post(
  '/import-from-plex',
  // was Permission.MANAGE_USERS — re-pointed (creates new users)
  isAuthenticated(Permission2.MANAGE_USERS_CREATE),
  async (req, res, next) => {
    try {
      const settings = getSettings();
      const userRepository = getRepository(User);
      const body = req.body as { plexIds: string[] } | undefined;

      // taken from auth.ts
      const mainUser = await userRepository.findOneOrFail({
        select: { id: true, plexToken: true },
        where: { id: 1 },
      });
      const mainPlexTv = new PlexTvAPI(mainUser.plexToken ?? '');

      const plexUsersResponse = await mainPlexTv.getUsers();
      const createdUsers: User[] = [];
      for (const rawUser of plexUsersResponse.MediaContainer.User) {
        const account = rawUser.$;

        if (account.email) {
          const user = await userRepository
            .createQueryBuilder('user')
            .where('user.plexId = :id', { id: account.id })
            .orWhere('user.email = :email', {
              email: account.email.toLowerCase(),
            })
            .getOne();

          if (user) {
            // Update the user's avatar with their Plex thumbnail, in case it changed
            user.avatar = account.thumb;
            user.email = account.email;
            user.plexUsername = account.username;

            // Identity merge (v2): if the existing user row has no plexId yet,
            // populate plex* fields. This allows linking Plex onto any existing
            // user (LOCAL or JELLYFIN) — silent merge symmetry with auth.ts.
            // Only flip userType to PLEX when the row was originally LOCAL;
            // a JELLYFIN-originated user that links Plex keeps userType=JELLYFIN.
            if (user.plexId == null) {
              user.plexId = parseInt(account.id);
              if (user.userType === UserType.LOCAL) {
                user.userType = UserType.PLEX;
              }
            }
            await userRepository.save(user);
          } else if (!body || body.plexIds.includes(account.id)) {
            if (await mainPlexTv.checkUserAccess(parseInt(account.id))) {
              const newUser = new User({
                plexUsername: account.username,
                email: account.email,
                permissions: settings.main.defaultPermissions,
                plexId: parseInt(account.id),
                plexToken: '',
                avatar: account.thumb,
                userType: UserType.PLEX,
              });
              await userRepository.save(newUser);
              createdUsers.push(newUser);
            }
          }
        }
      }

      return res.status(201).json(User.filterMany(createdUsers));
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

router.post(
  '/import-from-jellyfin',
  // was Permission.MANAGE_USERS — re-pointed (creates new users)
  isAuthenticated(Permission2.MANAGE_USERS_CREATE),
  async (req, res, next) => {
    try {
      const settings = getSettings();
      const userRepository = getRepository(User);
      const body = req.body as { jellyfinUserIds: string[] };

      // taken from auth.ts
      const admin = await userRepository.findOneOrFail({
        where: { id: 1 },
        select: ['id', 'jellyfinDeviceId', 'jellyfinUserId'],
        order: { id: 'ASC' },
      });

      const jellyfinClient = JellyfinAPI.forJellyfin(
        settings.jellyfin,
        settings.jellyfin.apiKey,
        admin.jellyfinDeviceId ?? ''
      );
      jellyfinClient.setUserId(admin.jellyfinUserId ?? '');

      //const jellyfinUsersResponse = await jellyfinClient.getUsers();
      const createdUsers: User[] = [];

      jellyfinClient.setUserId(admin.jellyfinUserId ?? '');
      const jellyfinUsers = await jellyfinClient.getUsers();

      const jellyfinUsersById = new Map(
        jellyfinUsers.users.map((user) => [
          normalizeJellyfinGuid(user.Id),
          user,
        ])
      );

      for (const rawJellyfinUserId of body.jellyfinUserIds) {
        const jellyfinUserId = normalizeJellyfinGuid(rawJellyfinUserId);
        if (!jellyfinUserId) {
          continue;
        }

        const jellyfinUser = jellyfinUsersById.get(jellyfinUserId);

        // Identity merge (v2): look up by jellyfinUserId first, then fall back
        // to email match (mirrors the import-from-plex shape). The
        // Jellyfin-side "email" is best-effort — Jellyfin's user object does
        // not always carry one, so we use Name as a secondary key when no
        // explicit email is present (parity with the silent-merge auth flow).
        const candidateEmail = (jellyfinUser as { Email?: string } | undefined)
          ?.Email;
        const user = await userRepository
          .createQueryBuilder('user')
          .where('user.jellyfinUserId = :jid', { jid: jellyfinUserId })
          .orWhere(candidateEmail ? 'LOWER(user.email) = :email' : '1 = 0', {
            email: candidateEmail?.toLowerCase(),
          })
          .getOne();

        if (user) {
          // Existing user (matched by email) without jellyfin* fields yet —
          // populate them so the row becomes dual-linked.
          if (user.jellyfinUserId == null && jellyfinUser?.Id) {
            user.jellyfinUsername = jellyfinUser.Name;
            user.jellyfinUserId = jellyfinUser.Id;
            user.jellyfinDeviceId = Buffer.from(
              `BOT_seerr_${jellyfinUser.Name ?? ''}`
            ).toString('base64');
            if (!user.avatar) {
              user.avatar = `/avatarproxy/${jellyfinUser.Id}`;
            }
            // Only flip userType when the row was LOCAL; PLEX-originated rows
            // keep userType=PLEX as the originating provider.
            if (user.userType === UserType.LOCAL) {
              user.userType = UserType.JELLYFIN;
            }
            await userRepository.save(user);
          }
        } else {
          const newUser = new User({
            jellyfinUsername: jellyfinUser?.Name,
            jellyfinUserId: jellyfinUser?.Id,
            jellyfinDeviceId: Buffer.from(
              `BOT_seerr_${jellyfinUser?.Name ?? ''}`
            ).toString('base64'),
            email: jellyfinUser?.Name,
            permissions: settings.main.defaultPermissions,
            avatar: `/avatarproxy/${jellyfinUser?.Id}`,
            userType: UserType.JELLYFIN,
          });

          await userRepository.save(newUser);
          createdUsers.push(newUser);
        }
      }
      return res.status(201).json(User.filterMany(createdUsers));
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

router.post(
  '/import-from-emby',
  // was Permission.MANAGE_USERS — re-pointed (creates new users)
  isAuthenticated(Permission2.MANAGE_USERS_CREATE),
  async (req, res, next) => {
    try {
      const settings = getSettings();
      const userRepository = getRepository(User);
      const body = req.body as { embyUserIds: string[] };

      const admin = await userRepository.findOneOrFail({
        where: { id: 1 },
        select: ['id', 'embyDeviceId', 'embyUserId'],
        order: { id: 'ASC' },
      });

      const embyClient = JellyfinAPI.forEmby(
        settings.emby,
        settings.emby.apiKey,
        admin.embyDeviceId ?? ''
      );
      embyClient.setUserId(admin.embyUserId ?? '');

      const createdUsers: User[] = [];
      const embyUsers = await embyClient.getUsers();

      const embyUsersById = new Map(
        embyUsers.users.map((user) => [normalizeJellyfinGuid(user.Id), user])
      );

      for (const rawEmbyUserId of body.embyUserIds) {
        const embyUserId = normalizeJellyfinGuid(rawEmbyUserId);
        if (!embyUserId) {
          continue;
        }

        const embyUser = embyUsersById.get(embyUserId);
        const candidateEmail = (embyUser as { Email?: string } | undefined)
          ?.Email;
        const user = await userRepository
          .createQueryBuilder('user')
          .where('user.embyUserId = :eid', { eid: embyUserId })
          .orWhere(candidateEmail ? 'LOWER(user.email) = :email' : '1 = 0', {
            email: candidateEmail?.toLowerCase(),
          })
          .getOne();

        if (user) {
          if (user.embyUserId == null && embyUser?.Id) {
            user.embyUsername = embyUser.Name;
            user.embyUserId = embyUser.Id;
            user.embyDeviceId = Buffer.from(
              `BOT_seerr_${embyUser.Name ?? ''}`
            ).toString('base64');
            if (!user.avatar) {
              user.avatar = `/avatarproxy/${embyUser.Id}?provider=emby`;
            }
            if (user.userType === UserType.LOCAL) {
              user.userType = UserType.EMBY;
            }
            await userRepository.save(user);
          }
        } else {
          const newUser = new User({
            embyUsername: embyUser?.Name,
            embyUserId: embyUser?.Id,
            embyDeviceId: Buffer.from(
              `BOT_seerr_${embyUser?.Name ?? ''}`
            ).toString('base64'),
            email: embyUser?.Name,
            permissions: settings.main.defaultPermissions,
            avatar: `/avatarproxy/${embyUser?.Id}?provider=emby`,
            userType: UserType.EMBY,
          });

          await userRepository.save(newUser);
          createdUsers.push(newUser);
        }
      }
      return res.status(201).json(User.filterMany(createdUsers));
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

router.get<{ id: string }, QuotaResponse>(
  '/:id/quota',
  async (req, res, next) => {
    try {
      const userRepository = getRepository(User);

      if (
        Number(req.params.id) !== req.user?.id &&
        !req.user?.hasPermission(
          [Permission.MANAGE_USERS, Permission.MANAGE_REQUESTS],
          { type: 'and' }
        )
      ) {
        return next({
          status: 403,
          message:
            "You do not have permission to view this user's request limits.",
        });
      }

      const user = await userRepository.findOneOrFail({
        where: { id: Number(req.params.id) },
      });

      const quotas = await user.getQuota();

      return res.status(200).json(quotas);
    } catch (e) {
      next({ status: 404, message: e.message });
    }
  }
);

router.get<{ id: string }, UserWatchDataResponse>(
  '/:id/watch_data',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    const settings = getSettings().tautulli;

    if (!settings.hostname || !settings.port || !settings.apiKey) {
      return next({
        status: 404,
        message: 'Tautulli API not configured.',
      });
    }

    try {
      const user = await getRepository(User).findOneOrFail({
        where: { id: Number(req.params.id) },
        select: { id: true, plexId: true },
      });

      const tautulli = new TautulliAPI(settings);

      const watchStats = await tautulli.getUserWatchStats(user);
      const watchHistory = await tautulli.getUserWatchHistory(user);

      const recentlyWatched = sortBy(
        await getRepository(Media).find({
          where: [
            {
              mediaType: MediaType.MOVIE,
              ratingKey: In(
                watchHistory
                  .filter((record) => record.media_type === 'movie')
                  .map((record) => record.rating_key)
              ),
            },
            {
              mediaType: MediaType.MOVIE,
              ratingKey4k: In(
                watchHistory
                  .filter((record) => record.media_type === 'movie')
                  .map((record) => record.rating_key)
              ),
            },
            {
              mediaType: MediaType.TV,
              ratingKey: In(
                watchHistory
                  .filter((record) => record.media_type === 'episode')
                  .map((record) => record.grandparent_rating_key)
              ),
            },
            {
              mediaType: MediaType.TV,
              ratingKey4k: In(
                watchHistory
                  .filter((record) => record.media_type === 'episode')
                  .map((record) => record.grandparent_rating_key)
              ),
            },
          ],
        }),
        [
          (media) =>
            findIndex(
              watchHistory,
              (record) =>
                (!!media.ratingKey &&
                  parseInt(media.ratingKey) ===
                    (record.media_type === 'movie'
                      ? record.rating_key
                      : record.grandparent_rating_key)) ||
                (!!media.ratingKey4k &&
                  parseInt(media.ratingKey4k) ===
                    (record.media_type === 'movie'
                      ? record.rating_key
                      : record.grandparent_rating_key))
            ),
        ]
      );

      return res.status(200).json({
        recentlyWatched,
        playCount: watchStats.total_plays,
      });
    } catch (e) {
      logger.error('Something went wrong fetching user watch data', {
        label: 'API',
        errorMessage: e.message,
        userId: req.params.id,
      });
      next({
        status: 500,
        message: 'Failed to fetch user watch data.',
      });
    }
  }
);

router.get<{ id: string }, WatchlistResponse>(
  '/:id/watchlist',
  async (req, res, next) => {
    if (
      Number(req.params.id) !== req.user?.id &&
      !req.user?.hasPermission(
        [Permission.MANAGE_REQUESTS, Permission.WATCHLIST_VIEW],
        {
          type: 'or',
        }
      )
    ) {
      return next({
        status: 403,
        message: "You do not have permission to view this user's Watchlist.",
      });
    }

    const itemsPerPage = 20;
    const page = req.query.page ? Number(req.query.page) : 1;
    const offset = (page - 1) * itemsPerPage;

    const user = await getRepository(User).findOneOrFail({
      where: { id: Number(req.params.id) },
      select: ['id', 'plexToken'],
    });

    if (user) {
      const [result, total] = await getRepository(Watchlist).findAndCount({
        where: { requestedBy: { id: user?.id } },
        relations: {
          /*requestedBy: true,media:true*/
        },
        // loadRelationIds: true,
        take: itemsPerPage,
        skip: offset,
      });
      if (total) {
        return res.json({
          page: page,
          totalPages: Math.ceil(total / itemsPerPage),
          totalResults: total,
          results: result,
        });
      }
    }

    // We will just return an empty array if the user has no Plex token
    if (!user.plexToken) {
      return res.json({
        page: 1,
        totalPages: 1,
        totalResults: 0,
        results: [],
      });
    }

    const plexTV = new PlexTvAPI(user.plexToken);

    const watchlist = await plexTV.getWatchlist({ offset });

    return res.json({
      page,
      totalPages: Math.ceil(watchlist.totalSize / itemsPerPage),
      totalResults: watchlist.totalSize,
      results: watchlist.items.map((item) => ({
        id: item.tmdbId,
        ratingKey: item.ratingKey,
        title: item.title,
        mediaType: item.type === 'show' ? 'tv' : 'movie',
        tmdbId: item.tmdbId,
      })),
    });
  }
);

export default router;
