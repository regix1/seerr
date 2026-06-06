import TitleCard from '@app/components/TitleCard';
import globalMessages from '@app/i18n/globalMessages';
import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { debounce } from 'lodash';
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { useIntl } from 'react-intl';

interface SliderProps {
  sliderKey: string;
  items?: JSX.Element[];
  isLoading: boolean;
  isEmpty?: boolean;
  emptyMessage?: React.ReactNode;
  placeholder?: React.ReactNode;
}

enum Direction {
  RIGHT,
  LEFT,
}

const Slider = ({
  sliderKey,
  items,
  isLoading,
  isEmpty = false,
  emptyMessage,
  placeholder = <TitleCard.Placeholder />,
}: SliderProps) => {
  const intl = useIntl();
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollPos, setScrollPos] = useState({ isStart: true, isEnd: false });

  const handleScroll = useCallback(() => {
    const margin = 5;
    const scrollWidth = containerRef.current?.scrollWidth ?? 0;
    const clientWidth =
      containerRef.current?.getBoundingClientRect().width ?? 0;
    const scrollPosition = containerRef.current?.scrollLeft ?? 0;

    if (!items || items?.length === 0) {
      setScrollPos({ isStart: true, isEnd: true });
    } else if (clientWidth >= scrollWidth) {
      setScrollPos({ isStart: true, isEnd: true });
    } else if (
      scrollPosition >=
      (containerRef.current?.scrollWidth ?? 0) - clientWidth - margin
    ) {
      setScrollPos({ isStart: false, isEnd: true });
    } else if (scrollPosition > margin) {
      setScrollPos({ isStart: false, isEnd: false });
    } else {
      setScrollPos({ isStart: true, isEnd: false });
    }
  }, [items]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const debouncedScroll = useCallback(
    debounce(() => handleScroll(), 50),
    [handleScroll]
  );

  useEffect(() => {
    const handleResize = () => {
      debouncedScroll();
    };

    window.addEventListener('resize', handleResize, { passive: true });

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [debouncedScroll]);

  useEffect(() => {
    handleScroll();
  }, [items, handleScroll]);

  const onScroll = () => {
    debouncedScroll();
  };

  const slide = (direction: Direction) => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const clientWidth = container.getBoundingClientRect().width;
    const cardWidth =
      container.firstElementChild?.getBoundingClientRect().width ?? 0;
    const scrollPosition = container.scrollLeft;
    const maxScroll = container.scrollWidth - clientWidth;

    // Move a full "page" of whole cards per click, snapping to the card grid.
    // Fall back to the viewport width when the card width can't be measured.
    const visibleItems =
      cardWidth > 0 ? Math.floor(clientWidth / cardWidth) : 0;
    const scrollOffset = cardWidth > 0 ? scrollPosition % cardWidth : 0;
    const distance = visibleItems > 0 ? visibleItems * cardWidth : clientWidth;

    const newX =
      direction === Direction.LEFT
        ? Math.max(scrollPosition - scrollOffset - distance, 0)
        : Math.min(scrollPosition - scrollOffset + distance, maxScroll);

    container.scrollTo({ left: newX, behavior: 'smooth' });

    // Optimistically refresh the arrow enabled/disabled state; the container's
    // onScroll handler also refreshes it as the smooth scroll progresses.
    if (newX <= 0) {
      setScrollPos({ isStart: true, isEnd: false });
    } else if (newX >= maxScroll) {
      setScrollPos({ isStart: false, isEnd: true });
    } else {
      setScrollPos({ isStart: false, isEnd: false });
    }
  };

  return (
    <div className="relative" data-testid="media-slider">
      <div className="absolute right-0 -mt-10 flex text-gray-400">
        <button
          className={`${
            scrollPos.isStart ? 'text-gray-800' : 'hover:text-white'
          }`}
          onClick={() => slide(Direction.LEFT)}
          disabled={scrollPos.isStart}
          type="button"
        >
          <ChevronLeftIcon className="h-6 w-6" />
        </button>
        <button
          className={`${
            scrollPos.isEnd ? 'text-gray-800' : 'hover:text-white'
          }`}
          onClick={() => slide(Direction.RIGHT)}
          disabled={scrollPos.isEnd}
          type="button"
        >
          <ChevronRightIcon className="h-6 w-6" />
        </button>
      </div>
      <div
        className="hide-scrollbar relative -my-2 -ml-4 -mr-4 overflow-y-auto overflow-x-scroll overscroll-x-contain whitespace-nowrap px-2 py-2"
        ref={containerRef}
        onScroll={onScroll}
      >
        {items?.map((item, index) => (
          <div
            key={`${sliderKey}-${index}`}
            className="inline-block px-2 align-top"
          >
            {item}
          </div>
        ))}
        {isLoading &&
          [...Array(10)].map((_item, i) => (
            <div
              key={`placeholder-${i}`}
              className="inline-block px-2 align-top"
            >
              {placeholder}
            </div>
          ))}
        {isEmpty && (
          <div className="mb-16 mt-16 text-center font-medium text-gray-400">
            {emptyMessage
              ? emptyMessage
              : intl.formatMessage(globalMessages.noresults)}
          </div>
        )}
      </div>
    </div>
  );
};

export default Slider;
