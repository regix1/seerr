import useDeepLinks from '@app/hooks/useDeepLinks';
import {
  getMediaServerPlayLinks,
  type MediaPlaySourceFields,
  type MediaServerPlayLink,
} from '@app/utils/mediaServerPlayLinks';
import { useMemo } from 'react';

const useMediaServerPlayLinks = (
  media: MediaPlaySourceFields | undefined | null,
  is4k = false
): MediaServerPlayLink[] => {
  const { mediaUrl: plexUrl, mediaUrl4k: plexUrl4k } = useDeepLinks({
    mediaUrl: media?.mediaUrl,
    mediaUrl4k: media?.mediaUrl4k,
    iOSPlexUrl: media?.iOSPlexUrl,
    iOSPlexUrl4k: media?.iOSPlexUrl4k,
  });

  return useMemo(
    () => getMediaServerPlayLinks(media, is4k, is4k ? plexUrl4k : plexUrl),
    [is4k, media, plexUrl, plexUrl4k]
  );
};

export default useMediaServerPlayLinks;
