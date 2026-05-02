import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import ImageProxy from '@server/lib/imageproxy';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { getAppVersion } from '@server/utils/appVersion';
import { getHostname } from '@server/utils/getHostname';
import axios from 'axios';
import { Router } from 'express';
import gravatarUrl from 'gravatar-url';
import { createHash } from 'node:crypto';

const router = Router();

type AvatarProvider = 'jellyfin' | 'emby';

const avatarImageProxies: Record<AvatarProvider, ImageProxy | null> = {
  jellyfin: null,
  emby: null,
};

async function initAvatarImageProxy(provider: AvatarProvider) {
  if (!avatarImageProxies[provider]) {
    const userRepository = getRepository(User);
    const admin = await userRepository.findOne({
      where: { id: 1 },
      select: ['id', 'jellyfinUserId', 'jellyfinDeviceId', 'embyDeviceId'],
      order: { id: 'ASC' },
    });
    const settings = getSettings();
    const deviceId =
      provider === 'emby'
        ? admin?.embyDeviceId || 'BOT_seerr'
        : admin?.jellyfinDeviceId || 'BOT_seerr';
    const authToken =
      provider === 'emby' ? settings.emby.apiKey : settings.jellyfin.apiKey;
    avatarImageProxies[provider] = new ImageProxy('avatar', '', {
      headers: {
        'X-Emby-Authorization': `MediaBrowser Client="Seerr", Device="Seerr", DeviceId="${deviceId}", Version="${
          provider === 'emby' ? '1.0.0' : getAppVersion()
        }", Token="${authToken}"`,
      },
    });
  }
  return avatarImageProxies[provider];
}

function getJellyfinAvatarUrl(userId: string, provider: AvatarProvider) {
  const settings = getSettings();
  if (provider === 'emby') {
    return `${getHostname(settings.emby)}/Users/${userId}/Images/Primary?quality=90`;
  }
  return `${getHostname(settings.jellyfin)}/UserImage?UserId=${userId}`;
}

function computeImageHash(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export async function checkAvatarChanged(
  user: User,
  provider: AvatarProvider = 'jellyfin'
): Promise<{ changed: boolean; etag?: string }> {
  try {
    const userId = provider === 'emby' ? user.embyUserId : user.jellyfinUserId;
    if (!user || !userId) {
      return { changed: false };
    }

    const jellyfinAvatarUrl = getJellyfinAvatarUrl(userId, provider);

    let headResponse;
    try {
      headResponse = await axios.head(jellyfinAvatarUrl);
      if (headResponse.status !== 200) {
        return { changed: false };
      }
    } catch {
      return { changed: false };
    }

    let remoteVersion: string;
    if (provider === 'jellyfin') {
      const remoteLastModifiedStr = headResponse.headers['last-modified'] || '';
      remoteVersion = (
        Date.parse(remoteLastModifiedStr) || Date.now()
      ).toString();
    } else if (provider === 'emby') {
      remoteVersion =
        headResponse.headers['etag']?.replace(/"/g, '') ||
        Date.now().toString();
    } else {
      remoteVersion = Date.now().toString();
    }

    if (user.avatarVersion && user.avatarVersion === remoteVersion) {
      return { changed: false, etag: user.avatarETag ?? undefined };
    }

    const avatarImageCache = await initAvatarImageProxy(provider);
    await avatarImageCache.clearCachedImage(jellyfinAvatarUrl);
    const imageData = await avatarImageCache.getImage(
      jellyfinAvatarUrl,
      gravatarUrl(user.email || 'none', { default: 'mm', size: 200 })
    );

    const newHash = computeImageHash(imageData.imageBuffer);

    const hasChanged = user.avatarETag !== newHash;

    user.avatarVersion = remoteVersion;
    if (hasChanged) {
      user.avatarETag = newHash;
    }

    await getRepository(User).save(user);

    return { changed: hasChanged, etag: newHash };
  } catch (error) {
    logger.error('Error checking avatar changes', {
      errorMessage: error.message,
    });
    return { changed: false };
  }
}

router.get('/:jellyfinUserId', async (req, res) => {
  try {
    const provider =
      req.query.provider === 'emby' ? 'emby' : ('jellyfin' as AvatarProvider);
    if (!req.params.jellyfinUserId.match(/^[a-f0-9]{32}$/)) {
      throw new Error(
        `Provided URL is not ${provider === 'emby' ? 'an Emby' : 'a Jellyfin'} avatar.`
      );
    }

    const avatarImageCache = await initAvatarImageProxy(provider);

    const userEtag = req.headers['if-none-match'];

    const versionParam = req.query.v;

    const user = await getRepository(User).findOne({
      where:
        provider === 'emby'
          ? { embyUserId: req.params.jellyfinUserId }
          : { jellyfinUserId: req.params.jellyfinUserId },
    });

    const fallbackUrl = gravatarUrl(user?.email || 'none', {
      default: 'mm',
      size: 200,
    });

    const jellyfinAvatarUrl = getJellyfinAvatarUrl(
      req.params.jellyfinUserId,
      provider
    );

    let imageData;
    if (user?.avatarVersion) {
      imageData = await avatarImageCache.getImage(
        jellyfinAvatarUrl,
        fallbackUrl
      );
      if (imageData.meta.extension === 'json') {
        imageData = await avatarImageCache.getImage(fallbackUrl);
      }
    } else {
      imageData = await avatarImageCache.getImage(fallbackUrl);
    }

    if (userEtag && userEtag === `"${imageData.meta.etag}"` && !versionParam) {
      return res.status(304).end();
    }

    res.writeHead(200, {
      'Content-Type': `image/${imageData.meta.extension}`,
      'Content-Length': imageData.imageBuffer.length,
      'Cache-Control': `public, max-age=${imageData.meta.curRevalidate}`,
      ETag: `"${imageData.meta.etag}"`,
      'OS-Cache-Key': imageData.meta.cacheKey,
      'OS-Cache-Status': imageData.meta.cacheMiss ? 'MISS' : 'HIT',
    });

    res.end(imageData.imageBuffer);
  } catch (e) {
    logger.error('Failed to proxy avatar image', {
      errorMessage: e.message,
    });
  }
});

export default router;
