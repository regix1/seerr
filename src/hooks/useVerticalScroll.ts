import { debounce } from 'lodash';
import type { MutableRefObject } from 'react';
import { useEffect, useRef, useState } from 'react';

const IS_SCROLLING_CHECK_THROTTLE = 200;
const BUFFER_HEIGHT = 200;

/**
 * useVerticalScroll is a custom hook to handle infinite scrolling
 *
 * @param callback Callback is executed when page reaches bottom
 * @param shouldFetch Disables callback if true
 * @param contentLength Number of loaded items; used to re-check when content grows
 */
const useVerticalScroll = (
  callback: () => void,
  shouldFetch: boolean,
  contentLength = 0
): boolean => {
  const [isScrolling, setScrolling] = useState(false);

  type SetTimeoutReturnType = ReturnType<typeof setTimeout>;
  const scrollingTimer: MutableRefObject<SetTimeoutReturnType | undefined> =
    useRef(undefined);
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  const shouldFetchRef = useRef(shouldFetch);
  shouldFetchRef.current = shouldFetch;

  const debouncedCallbackRef = useRef(
    debounce(() => {
      if (!shouldFetchRef.current) {
        return;
      }

      const scrollTop = Math.max(
        window.pageYOffset,
        document.documentElement.scrollTop,
        document.body.scrollTop
      );
      if (
        window.innerHeight + scrollTop >=
        document.documentElement.offsetHeight - BUFFER_HEIGHT
      ) {
        callbackRef.current();
      }
    }, 50)
  );

  // Re-check when content grows (e.g. after fetch) but not on every render
  useEffect(() => {
    debouncedCallbackRef.current();
  }, [shouldFetch, contentLength]);

  useEffect(() => {
    const debouncedCallback = debouncedCallbackRef.current;

    const onScroll = () => {
      if (scrollingTimer.current !== undefined) {
        clearTimeout(scrollingTimer.current);
      }
      if (!isScrolling) {
        setScrolling(true);
      }

      scrollingTimer.current = setTimeout(() => {
        setScrolling(false);
      }, IS_SCROLLING_CHECK_THROTTLE);
      debouncedCallback();
    };

    const onResize = () => {
      debouncedCallback();
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize, { passive: true });

    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);

      if (scrollingTimer.current !== undefined) {
        clearTimeout(scrollingTimer.current);
      }
      debouncedCallback.cancel();
    };
  }, [isScrolling]);

  return isScrolling;
};

export default useVerticalScroll;
