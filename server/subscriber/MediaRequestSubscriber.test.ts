import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { RadarrMovie } from '@server/api/servarr/radarr';
import RadarrAPI from '@server/api/servarr/radarr';
import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import type { RadarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';

// --- Test doubles for the network-heavy *arr / TMDB calls -------------------
// We swap the prototype methods so the subscriber's deferred dispatch exercises
// our controllable fakes instead of real HTTP.

interface AddMovieControl {
  invoked: boolean;
  resolve: (movie: RadarrMovie) => void;
  promise: Promise<RadarrMovie>;
}

let addMovieControl: AddMovieControl;

function makeAddMovieControl(): AddMovieControl {
  let resolveFn: (movie: RadarrMovie) => void = () => undefined;
  const promise = new Promise<RadarrMovie>((resolve) => {
    resolveFn = resolve;
  });
  return { invoked: false, resolve: resolveFn, promise };
}

const fakeRadarrMovie: RadarrMovie = {
  tmdbId: 777,
  id: 99,
  title: 'Deferred Movie',
  titleSlug: 'deferred-movie',
  monitored: true,
  hasFile: false,
  isAvailable: true,
  imdbId: 'tt0000777',
  folderName: '/movies/Deferred Movie',
  path: '/movies/Deferred Movie',
  profileId: 1,
  qualityProfileId: 1,
  added: '2024-01-01T00:00:00Z',
  tags: [],
};

// RadarrAPI/TheMovieDb expose these as instance-assigned arrow-function fields
// (set in the constructor), so a plain `Prototype.method = ...` is shadowed by
// the instance. We define a prototype getter with a no-op setter (the same
// pattern the scanner tests use) so the instance assignment is swallowed and
// our fake wins. Implementations are swapped via module-level vars.
let getTagsImpl: () => Promise<
  { id: number; label: string }[]
> = async () => [];
let addMovieImpl: () => Promise<RadarrMovie> = async () => {
  addMovieControl.invoked = true;
  // Intentionally slow: resolves only when the test releases it.
  return addMovieControl.promise;
};
let getMovieImpl: () => Promise<{
  id: number;
  title: string;
  release_date: string;
}> = async () => ({
  id: 777,
  title: 'Deferred Movie',
  release_date: '2024-01-01',
});

Object.defineProperty(RadarrAPI.prototype, 'getTags', {
  set() {},
  get() {
    return () => getTagsImpl();
  },
  configurable: true,
});
Object.defineProperty(RadarrAPI.prototype, 'addMovie', {
  set() {},
  get() {
    return () => addMovieImpl();
  },
  configurable: true,
});
Object.defineProperty(RadarrAPI.prototype, 'clearCache', {
  set() {},
  get() {
    return () => undefined;
  },
  configurable: true,
});
Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  set() {},
  get() {
    return () => getMovieImpl();
  },
  configurable: true,
});

function configureRadarr(overrides: Partial<RadarrSettings> = {}): void {
  const settings = getSettings();
  settings.radarr = [
    {
      id: 0,
      name: 'Radarr 0',
      hostname: 'localhost',
      port: 7878,
      apiKey: 'test-key',
      baseUrl: '',
      useSsl: false,
      activeProfileId: 1,
      activeDirectory: '/movies',
      is4k: false,
      minimumAvailability: 'released',
      tags: [],
      isDefault: true,
      syncEnabled: true,
      preventSearch: false,
      externalUrl: '',
      tagRequests: false,
      ...overrides,
    },
  ] as RadarrSettings[];
  settings.sonarr = [];
}

async function createMedia(status: MediaStatus): Promise<Media> {
  const mediaRepository = getRepository(Media);
  return mediaRepository.save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId: 777,
      status,
      status4k: MediaStatus.UNKNOWN,
    })
  );
}

async function requester(): Promise<User> {
  return getRepository(User).findOneOrFail({
    where: { email: 'friend@seerr.dev' },
  });
}

/**
 * Polls a predicate across event-loop turns until it is satisfied (or a bounded
 * number of turns elapse). Used to drain the post-commit setImmediate dispatch
 * deterministically without coupling the test to an exact tick count.
 */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  maxTurns = 50
): Promise<void> {
  for (let i = 0; i < maxTurns && !(await predicate()); i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

setupTestDb();

describe('MediaRequestSubscriber — deferred *arr dispatch', () => {
  beforeEach(() => {
    addMovieControl = makeAddMovieControl();
    getTagsImpl = async () => [];
    addMovieImpl = async () => {
      addMovieControl.invoked = true;
      return addMovieControl.promise;
    };
    getMovieImpl = async () => ({
      id: 777,
      title: 'Deferred Movie',
      release_date: '2024-01-01',
    });
    configureRadarr();
  });

  afterEach(async () => {
    // Release the pending add and let the deferred dispatch chain FULLY finish
    // (its post-add mediaRepository.save) so no DB query/transaction is still in
    // flight when the next test file's setupTestDb runs synchronize(true). A
    // leftover in-flight transaction on the shared sqlite connection makes the
    // next schema rebuild throw "cannot start a transaction within a
    // transaction", which otherwise cancels unrelated test files.
    addMovieControl.resolve(fakeRadarrMovie);

    // Wait until the deferred dispatch has written the radarr link back to the
    // media row (the last DB write in the addMovie().then() chain), or until a
    // generous bound elapses, then give the connection a couple of extra turns
    // to settle the COMMIT.
    const mediaRepository = getRepository(Media);
    await waitFor(async () => {
      const m = await mediaRepository.findOne({ where: { tmdbId: 777 } });
      return !m || m.externalServiceId != null;
    });
    await waitFor(() => false, 5);
  });

  it('resolves the save() before the slow Radarr add completes (response not gated)', async () => {
    const media = await createMedia(MediaStatus.UNKNOWN);
    const requestRepository = getRepository(MediaRequest);

    const request = new MediaRequest({
      type: MediaType.MOVIE,
      status: MediaRequestStatus.APPROVED,
      media,
      requestedBy: await requester(),
      is4k: false,
    });

    // The save() must NOT wait on the Radarr add. addMovie is intentionally
    // left unresolved for the lifetime of this assertion.
    await requestRepository.save(request);

    // At the moment save() resolved, addMovie must not even have been invoked:
    // the add is deferred to a post-commit tick, so the response (which returns
    // right after save resolves) is fully decoupled from the *arr round-trip.
    assert.equal(addMovieControl.invoked, false);

    // The parent media should have been flipped to PROCESSING synchronously, so
    // the response body is accurate.
    const reloaded = await getRepository(Media).findOneOrFail({
      where: { id: media.id },
    });
    assert.equal(reloaded.status, MediaStatus.PROCESSING);

    // Drain the deferred dispatch and confirm the add eventually fires
    // out-of-band, proving the work was deferred rather than dropped.
    await waitFor(() => addMovieControl.invoked);
    assert.equal(addMovieControl.invoked, true);
  });

  it('marks an already-AVAILABLE movie request COMPLETED synchronously', async () => {
    const media = await createMedia(MediaStatus.AVAILABLE);
    const requestRepository = getRepository(MediaRequest);

    const request = new MediaRequest({
      type: MediaType.MOVIE,
      status: MediaRequestStatus.APPROVED,
      media,
      requestedBy: await requester(),
      is4k: false,
    });

    await requestRepository.save(request);

    const saved = await requestRepository.findOneOrFail({
      where: { id: request.id },
    });
    // The synchronous COMPLETED determination must be reflected in the row that
    // backs the HTTP response, and the slow add must never be invoked.
    assert.equal(saved.status, MediaRequestStatus.COMPLETED);
    assert.equal(addMovieControl.invoked, false);
  });
});
