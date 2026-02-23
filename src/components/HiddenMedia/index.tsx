import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import ConfirmButton from '@app/components/Common/ConfirmButton';
import Header from '@app/components/Common/Header';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import { useUpdateQueryParams } from '@app/hooks/useUpdateQueryParams';
import globalMessages from '@app/i18n/globalMessages';
import Error from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  EyeIcon,
} from '@heroicons/react/24/solid';
import { MediaStatus } from '@server/constants/media';
import type Media from '@server/entity/Media';
import type { MediaResultsResponse } from '@server/interfaces/api/mediaInterfaces';
import type { MovieDetails } from '@server/models/Movie';
import type { TvDetails } from '@server/models/Tv';
import axios from 'axios';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { useInView } from 'react-intersection-observer';
import { useIntl } from 'react-intl';
import { useToasts } from 'react-toast-notifications';
import useSWR from 'swr';

const messages = defineMessages('components.HiddenMedia', {
  hiddenMedia: 'Hidden Media',
  hiddenMediaDescription: 'Manage media hidden from regular users.',
  unhideMedia: 'Unhide',
  unhideSuccess: '<strong>{title}</strong> has been unhidden.',
  unhideError: 'Something went wrong. Please try again.',
});

const isMovie = (movie: MovieDetails | TvDetails): movie is MovieDetails => {
  return (movie as MovieDetails).title !== undefined;
};

const HiddenMedia = () => {
  const [currentPageSize, setCurrentPageSize] = useState<number>(10);
  const router = useRouter();
  const intl = useIntl();

  const page = router.query.page ? Number(router.query.page) : 1;
  const pageIndex = page - 1;
  const updateQueryParams = useUpdateQueryParams({ page: page.toString() });

  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<MediaResultsResponse>(
    `/api/v1/media?take=${currentPageSize}&skip=${
      pageIndex * currentPageSize
    }&filter=hidden`,
    {
      refreshInterval: 0,
      revalidateOnFocus: false,
    }
  );

  if (!data && error) {
    return <Error statusCode={500} />;
  }

  const hasNextPage = data && data.pageInfo.pages > pageIndex + 1;
  const hasPrevPage = pageIndex > 0;

  return (
    <>
      <PageTitle title={[intl.formatMessage(messages.hiddenMedia)]} />
      <div className="mb-4 flex flex-col justify-between lg:flex-row lg:items-end">
        <Header>{intl.formatMessage(messages.hiddenMedia)}</Header>
      </div>

      {!data ? (
        <LoadingSpinner />
      ) : data.results.length === 0 ? (
        <div className="flex w-full flex-col items-center justify-center py-24 text-white">
          <span className="text-2xl text-gray-400">
            {intl.formatMessage(globalMessages.noresults)}
          </span>
        </div>
      ) : (
        data.results.map((item: Media) => (
          <div className="py-2" key={`hidden-media-${item.id}`}>
            <HiddenMediaItem item={item} revalidateList={revalidate} />
          </div>
        ))
      )}

      <div className="actions">
        <nav
          className="mb-3 flex flex-col items-center space-y-3 sm:flex-row sm:space-y-0"
          aria-label="Pagination"
        >
          <div className="hidden lg:flex lg:flex-1">
            <p className="text-sm">
              {data &&
                (data?.results.length ?? 0) > 0 &&
                intl.formatMessage(globalMessages.showingresults, {
                  from: pageIndex * currentPageSize + 1,
                  to:
                    data.results.length < currentPageSize
                      ? pageIndex * currentPageSize + data.results.length
                      : (pageIndex + 1) * currentPageSize,
                  total: data.pageInfo.results,
                  strong: (msg: React.ReactNode) => (
                    <span className="font-medium">{msg}</span>
                  ),
                })}
            </p>
          </div>
          <div className="flex justify-center sm:flex-1 sm:justify-start lg:justify-center">
            <span className="-mt-3 items-center truncate text-sm sm:mt-0">
              {intl.formatMessage(globalMessages.resultsperpage, {
                pageSize: (
                  <select
                    id="pageSize"
                    name="pageSize"
                    onChange={(e) => {
                      setCurrentPageSize(Number(e.target.value));
                      router
                        .push({
                          pathname: router.pathname,
                          query: {},
                        })
                        .then(() => window.scrollTo(0, 0));
                    }}
                    value={currentPageSize}
                    className="short inline"
                  >
                    <option value="5">5</option>
                    <option value="10">10</option>
                    <option value="25">25</option>
                    <option value="50">50</option>
                    <option value="100">100</option>
                  </select>
                ),
              })}
            </span>
          </div>
          <div className="flex flex-auto justify-center space-x-2 sm:flex-1 sm:justify-end">
            <Button
              disabled={!hasPrevPage}
              onClick={() => updateQueryParams('page', (page - 1).toString())}
            >
              <ChevronLeftIcon />
              <span>{intl.formatMessage(globalMessages.previous)}</span>
            </Button>
            <Button
              disabled={!hasNextPage}
              onClick={() => updateQueryParams('page', (page + 1).toString())}
            >
              <span>{intl.formatMessage(globalMessages.next)}</span>
              <ChevronRightIcon />
            </Button>
          </div>
        </nav>
      </div>
    </>
  );
};

export default HiddenMedia;

interface HiddenMediaItemProps {
  item: Media;
  revalidateList: () => void;
}

const HiddenMediaItem = ({ item, revalidateList }: HiddenMediaItemProps) => {
  const [isUpdating, setIsUpdating] = useState<boolean>(false);
  const { addToast } = useToasts();
  const { ref, inView } = useInView({
    triggerOnce: true,
  });
  const intl = useIntl();

  const url =
    item.mediaType === 'movie'
      ? `/api/v1/movie/${item.tmdbId}`
      : `/api/v1/tv/${item.tmdbId}`;
  const { data: title, error } = useSWR<MovieDetails | TvDetails>(
    inView ? url : null
  );

  if (!title && !error) {
    return (
      <div
        className="h-64 w-full animate-pulse rounded-xl bg-gray-800 xl:h-28"
        ref={ref}
      />
    );
  }

  const unhideMedia = async (mediaId: number, mediaTitle?: string) => {
    setIsUpdating(true);

    try {
      await axios.post(`/api/v1/media/${mediaId}/unhide`);

      addToast(
        <span>
          {intl.formatMessage(messages.unhideSuccess, {
            title: mediaTitle,
            strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
          })}
        </span>,
        { appearance: 'success', autoDismiss: true }
      );
    } catch {
      addToast(intl.formatMessage(messages.unhideError), {
        appearance: 'error',
        autoDismiss: true,
      });
    }

    revalidateList();
    setIsUpdating(false);
  };

  const mediaTitle = title && (isMovie(title) ? title.title : title.name);

  return (
    <div className="relative flex w-full flex-col justify-between overflow-hidden rounded-xl bg-gray-800 py-4 text-gray-400 shadow-md ring-1 ring-gray-700 xl:h-28 xl:flex-row">
      {title && title.backdropPath && (
        <div className="absolute inset-0 z-0 w-full bg-cover bg-center xl:w-2/3">
          <CachedImage
            type="tmdb"
            src={`https://image.tmdb.org/t/p/w1920_and_h800_multi_faces/${title.backdropPath}`}
            alt=""
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            fill
          />
          <div
            className="absolute inset-0"
            style={{
              backgroundImage:
                'linear-gradient(90deg, rgba(31, 41, 55, 0.47) 0%, rgba(31, 41, 55, 1) 100%)',
            }}
          />
        </div>
      )}
      <div className="relative flex w-full flex-col justify-between overflow-hidden sm:flex-row">
        <div className="relative z-10 flex w-full items-center overflow-hidden pl-4 pr-4 sm:pr-0 xl:w-7/12 2xl:w-2/3">
          <Link
            href={
              item.mediaType === 'movie'
                ? `/movie/${item.tmdbId}`
                : `/tv/${item.tmdbId}`
            }
            className="relative h-auto w-12 flex-shrink-0 scale-100 transform-gpu overflow-hidden rounded-md transition duration-300 hover:scale-105"
          >
            <CachedImage
              type="tmdb"
              src={
                title?.posterPath
                  ? `https://image.tmdb.org/t/p/w600_and_h900_bestv2${title.posterPath}`
                  : '/images/seerr_poster_not_found.png'
              }
              alt=""
              sizes="100vw"
              style={{ width: '100%', height: 'auto', objectFit: 'cover' }}
              width={600}
              height={900}
            />
          </Link>
          <div className="flex flex-col justify-center overflow-hidden pl-2 xl:pl-4">
            <div className="pt-0.5 text-xs font-medium text-white sm:pt-1">
              {title &&
                (isMovie(title)
                  ? title.releaseDate
                  : title.firstAirDate
                )?.slice(0, 4)}
            </div>
            <Link
              href={
                item.mediaType === 'movie'
                  ? `/movie/${item.tmdbId}`
                  : `/tv/${item.tmdbId}`
              }
            >
              <span className="mr-2 min-w-0 truncate text-lg font-bold text-white hover:underline xl:text-xl">
                {mediaTitle}
              </span>
            </Link>
          </div>
        </div>

        <div className="z-10 ml-4 mt-4 flex w-full flex-col justify-center overflow-hidden pr-4 text-sm sm:ml-2 sm:mt-0 xl:flex-1 xl:pr-0">
          <div className="card-field">
            <span className="card-field-name">
              {intl.formatMessage(globalMessages.status)}
            </span>
            <Badge badgeType="warning">
              {intl.formatMessage(messages.hiddenMedia)}
            </Badge>
            {item.status === MediaStatus.PROCESSING && (
              <Badge badgeType="primary">
                {intl.formatMessage(globalMessages.processing)}
              </Badge>
            )}
            {item.status === MediaStatus.AVAILABLE && (
              <Badge badgeType="success">
                {intl.formatMessage(globalMessages.available)}
              </Badge>
            )}
            {item.status === MediaStatus.PARTIALLY_AVAILABLE && (
              <Badge badgeType="success">
                {intl.formatMessage(globalMessages.partiallyavailable)}
              </Badge>
            )}
            {item.status === MediaStatus.PENDING && (
              <Badge badgeType="default">
                {intl.formatMessage(globalMessages.pending)}
              </Badge>
            )}
          </div>
          <div className="card-field">
            {item.mediaType === 'movie' ? (
              <div className="pointer-events-none z-40 self-start rounded-full border border-blue-500 bg-blue-600 bg-opacity-80 shadow-md">
                <div className="flex h-4 items-center px-2 py-2 text-center text-xs font-medium uppercase tracking-wider text-white sm:h-5">
                  {intl.formatMessage(globalMessages.movie)}
                </div>
              </div>
            ) : (
              <div className="pointer-events-none z-40 self-start rounded-full border border-purple-600 bg-purple-600 bg-opacity-80 shadow-md">
                <div className="flex h-4 items-center px-2 py-2 text-center text-xs font-medium uppercase tracking-wider text-white sm:h-5">
                  {intl.formatMessage(globalMessages.tvshow)}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="z-10 mt-4 flex w-full flex-col justify-center space-y-2 pl-4 pr-4 xl:mt-0 xl:w-96 xl:items-end xl:pl-0">
        <ConfirmButton
          onClick={() => unhideMedia(item.id, mediaTitle)}
          confirmText={intl.formatMessage(
            isUpdating ? globalMessages.deleting : globalMessages.areyousure
          )}
          className={`w-full ${
            isUpdating ? 'pointer-events-none opacity-50' : ''
          }`}
        >
          <EyeIcon />
          <span>{intl.formatMessage(messages.unhideMedia)}</span>
        </ConfirmButton>
      </div>
    </div>
  );
};
