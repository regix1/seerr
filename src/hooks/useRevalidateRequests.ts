import { mutate } from 'swr';

export const RECENT_REQUESTS_KEY =
  '/api/v1/request?filter=all&take=10&sort=modified&skip=0';

const REQUEST_COUNT_KEY = '/api/v1/request/count';

export const revalidateRequests = (): void => {
  mutate(RECENT_REQUESTS_KEY);
  mutate(REQUEST_COUNT_KEY);
};
