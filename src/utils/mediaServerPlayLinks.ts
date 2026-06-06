export type MediaServerName = 'Plex' | 'Emby' | 'Jellyfin';

export interface MediaServerPlayLink {
  url: string;
  mediaServerName: MediaServerName;
}

export interface MediaPlaySourceFields {
  ratingKey?: string | null;
  ratingKey4k?: string | null;
  mediaUrl?: string;
  mediaUrl4k?: string;
  iOSPlexUrl?: string;
  iOSPlexUrl4k?: string;
  jellyfinMediaId?: string | null;
  jellyfinMediaId4k?: string | null;
  jellyfinMediaUrl?: string;
  jellyfinMediaUrl4k?: string;
  embyMediaId?: string | null;
  embyMediaId4k?: string | null;
  embyMediaUrl?: string;
  embyMediaUrl4k?: string;
}

export function getMediaServerPlayLinks(
  media: MediaPlaySourceFields | undefined | null,
  is4k: boolean,
  resolvedPlexUrl?: string
): MediaServerPlayLink[] {
  if (!media) {
    return [];
  }

  const links: MediaServerPlayLink[] = [];
  const seenUrls = new Set<string>();

  const addLink = (
    url: string | undefined,
    mediaServerName: MediaServerName
  ) => {
    if (!url || seenUrls.has(url)) {
      return;
    }

    seenUrls.add(url);
    links.push({ url, mediaServerName });
  };

  const hasPlex = is4k ? media.ratingKey4k : media.ratingKey;
  if (hasPlex) {
    addLink(resolvedPlexUrl, 'Plex');
  }

  const hasEmby = is4k ? media.embyMediaId4k : media.embyMediaId;
  if (hasEmby) {
    addLink(is4k ? media.embyMediaUrl4k : media.embyMediaUrl, 'Emby');
  }

  const hasJellyfin = is4k ? media.jellyfinMediaId4k : media.jellyfinMediaId;
  if (hasJellyfin) {
    addLink(
      is4k ? media.jellyfinMediaUrl4k : media.jellyfinMediaUrl,
      'Jellyfin'
    );
  }

  return links;
}
