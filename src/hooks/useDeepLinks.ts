import { useEffect, useState } from 'react';

interface useDeepLinksProps {
  mediaUrl?: string;
  mediaUrl4k?: string;
  iOSPlexUrl?: string;
  iOSPlexUrl4k?: string;
}

const useDeepLinks = ({
  mediaUrl,
  mediaUrl4k,
  iOSPlexUrl,
  iOSPlexUrl4k,
}: useDeepLinksProps) => {
  const [returnedMediaUrl, setReturnedMediaUrl] = useState(mediaUrl);
  const [returnedMediaUrl4k, setReturnedMediaUrl4k] = useState(mediaUrl4k);

  useEffect(() => {
    const isIOS =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.userAgent.includes('Mac') && navigator.maxTouchPoints > 1);

    if (isIOS && mediaUrl?.includes('plex.tv')) {
      setReturnedMediaUrl(iOSPlexUrl);
    } else {
      setReturnedMediaUrl(mediaUrl);
    }

    if (isIOS && mediaUrl4k?.includes('plex.tv')) {
      setReturnedMediaUrl4k(iOSPlexUrl4k);
    } else {
      setReturnedMediaUrl4k(mediaUrl4k);
    }
  }, [iOSPlexUrl, iOSPlexUrl4k, mediaUrl, mediaUrl4k]);

  return { mediaUrl: returnedMediaUrl, mediaUrl4k: returnedMediaUrl4k };
};

export default useDeepLinks;
