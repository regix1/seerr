import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import type { RadarrMovie } from '@server/api/servarr/radarr';
import RadarrAPI from '@server/api/servarr/radarr';
import type { SonarrSeries } from '@server/api/servarr/sonarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbTvDetails,
  TmdbTvSeasonResult,
} from '@server/api/themoviedb/interfaces';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import Season from '@server/entity/Season';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';

// --- Mock RadarrAPI ---
let getMovieImpl: (args: { id: number }) => Promise<RadarrMovie> = async () => {
  throw new Error('404');
};

Object.defineProperty(RadarrAPI.prototype, 'getMovie', {
  get() {
    return async (args: { id: number }) => getMovieImpl(args);
  },
  set() {},
  configurable: true,
});

// --- Mock SonarrAPI ---
let getSeriesByIdImpl: (id: number) => Promise<SonarrSeries> = async () => {
  throw new Error('404');
};

Object.defineProperty(SonarrAPI.prototype, 'getSeriesById', {
  get() {
    return async (id: number) => getSeriesByIdImpl(id);
  },
  set() {},
  configurable: true,
});

// --- Mock TheMovieDb ---
let getTvShowImpl: (args: {
  tvId: number;
  language?: string;
}) => Promise<TmdbTvDetails> = async () => fakeTmdbShow(1);
let getShowByTvdbIdImpl: (args: {
  tvdbId: number;
  language?: string;
}) => Promise<TmdbTvDetails> = async () => fakeTmdbShow(1);

Object.defineProperty(TheMovieDb.prototype, 'getTvShow', {
  get() {
    return async (args: { tvId: number; language?: string }) =>
      getTvShowImpl(args);
  },
  set() {},
  configurable: true,
});

Object.defineProperty(TheMovieDb.prototype, 'getShowByTvdbId', {
  get() {
    return async (args: { tvdbId: number; language?: string }) =>
      getShowByTvdbIdImpl(args);
  },
  set() {},
  configurable: true,
});

// --- Helpers ---
function fakeTmdbShow(
  tmdbId: number,
  seasons: TmdbTvSeasonResult[] = [
    {
      id: 1,
      air_date: '2024-01-01',
      episode_count: 10,
      name: 'Season 1',
      overview: '',
      season_number: 1,
    },
  ]
): TmdbTvDetails {
  return {
    id: tmdbId,
    content_ratings: { results: [] },
    created_by: [],
    episode_run_time: [],
    first_air_date: '2024-01-01',
    genres: [],
    homepage: '',
    in_production: false,
    languages: ['en'],
    last_air_date: '2024-01-01',
    name: 'Test Show',
    networks: [],
    number_of_episodes: 10,
    number_of_seasons: seasons.length,
    origin_country: ['US'],
    original_language: 'en',
    original_name: 'Test Show',
    overview: '',
    popularity: 0,
    production_companies: [],
    production_countries: [],
    spoken_languages: [],
    seasons,
    status: 'Ended',
    type: 'Scripted',
    vote_average: 0,
    vote_count: 0,
    aggregate_credits: { cast: [] },
    credits: { crew: [] },
    external_ids: {},
    keywords: { results: [] },
    videos: { results: [] },
  };
}

function fakeRadarrMovie(overrides: Partial<RadarrMovie> = {}): RadarrMovie {
  return {
    tmdbId: 550,
    id: 1,
    title: 'Test Movie',
    titleSlug: 'test-movie',
    monitored: true,
    hasFile: true,
    isAvailable: true,
    imdbId: 'tt0137523',
    folderName: '/movies/Test Movie (2024)',
    path: '/movies/Test Movie (2024)',
    profileId: 1,
    qualityProfileId: 1,
    added: '2024-01-01T00:00:00Z',
    tags: [],
    ...overrides,
  };
}

function fakeSonarrSeries(
  seasonsWithFiles: Record<number, number>,
  totalSeasons = 1,
  overrides: Partial<SonarrSeries> = {}
): SonarrSeries {
  return {
    tvdbId: 12345,
    id: 1,
    title: 'Test Show',
    titleSlug: 'test-show',
    monitored: true,
    seasons: Array.from({ length: totalSeasons }, (_, i) => ({
      seasonNumber: i + 1,
      monitored: true,
      statistics: {
        episodeFileCount: seasonsWithFiles[i + 1] ?? 0,
        totalEpisodeCount: 10,
        episodeCount: 10,
        percentOfEpisodes: seasonsWithFiles[i + 1] ? 100 : 0,
        sizeOnDisk: seasonsWithFiles[i + 1] ? 7516192768 : 0,
        previousAiring: undefined,
      },
    })),
    ...overrides,
  } as unknown as SonarrSeries;
}

function configureRadarr(overrides: Partial<RadarrSettings>[] = [{}]): void {
  const settings = getSettings();
  settings.radarr = overrides.map((o, i) => ({
    id: i,
    name: `Radarr ${i}`,
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
    isDefault: i === 0,
    syncEnabled: true,
    preventSearch: false,
    externalUrl: '',
    ...o,
  })) as RadarrSettings[];
  settings.sonarr = [];
}

function configureSonarr(overrides: Partial<SonarrSettings>[] = [{}]): void {
  const settings = getSettings();
  settings.sonarr = overrides.map((o, i) => ({
    id: i,
    name: `Sonarr ${i}`,
    hostname: 'localhost',
    port: 8989,
    apiKey: 'test-key',
    baseUrl: '',
    useSsl: false,
    activeProfileId: 1,
    activeDirectory: '/tv',
    activeLanguageProfileId: 1,
    is4k: false,
    enableSeasonFolders: true,
    tags: [],
    isDefault: i === 0,
    syncEnabled: true,
    preventSearch: false,
    externalUrl: '',
    ...o,
  })) as SonarrSettings[];
  settings.radarr = [];
}

import { radarrScanner } from '@server/lib/scanners/radarr';
import { sonarrScanner } from '@server/lib/scanners/sonarr';

import { availabilityCheck } from '@server/lib/availabilityCheck';

setupTestDb();

describe('AvailabilityCheck', () => {
  beforeEach(() => {
    getMovieImpl = async () => {
      throw new Error('404');
    };
    getSeriesByIdImpl = async () => {
      throw new Error('404');
    };
    getTvShowImpl = async ({ tvId }) => fakeTmdbShow(tvId);
    getShowByTvdbIdImpl = async ({ tvdbId }) => fakeTmdbShow(tvdbId);
    // Ensure scanners are not flagged as running between tests.
    (radarrScanner as unknown as { running: boolean }).running = false;
    (sonarrScanner as unknown as { running: boolean }).running = false;
  });

  // (a) PROCESSING movie with Radarr hasFile=true -> AVAILABLE.
  it('flips a PROCESSING movie to AVAILABLE when Radarr reports hasFile', async () => {
    configureRadarr([{ syncEnabled: true }]);
    const mediaRepository = getRepository(Media);

    const media = new Media();
    media.tmdbId = 550;
    media.mediaType = MediaType.MOVIE;
    media.status = MediaStatus.PROCESSING;
    media.serviceId = 0;
    media.externalServiceId = 1;
    await mediaRepository.save(media);

    getMovieImpl = async () => fakeRadarrMovie({ hasFile: true });

    await availabilityCheck.run();

    const updated = await mediaRepository.findOneOrFail({
      where: { tmdbId: 550 },
    });
    assert.strictEqual(updated.status, MediaStatus.AVAILABLE);
  });

  // (b) hasFile=false -> stays PROCESSING.
  it('leaves a PROCESSING movie unchanged when Radarr has no file', async () => {
    configureRadarr([{ syncEnabled: true }]);
    const mediaRepository = getRepository(Media);

    const media = new Media();
    media.tmdbId = 551;
    media.mediaType = MediaType.MOVIE;
    media.status = MediaStatus.PROCESSING;
    media.serviceId = 0;
    media.externalServiceId = 1;
    await mediaRepository.save(media);

    getMovieImpl = async () =>
      fakeRadarrMovie({ tmdbId: 551, hasFile: false, monitored: true });

    await availabilityCheck.run();

    const updated = await mediaRepository.findOneOrFail({
      where: { tmdbId: 551 },
    });
    assert.strictEqual(updated.status, MediaStatus.PROCESSING);
  });

  // (c) partial series -> PARTIALLY_AVAILABLE.
  it('flips a PROCESSING series to PARTIALLY_AVAILABLE when only some episodes exist', async () => {
    configureSonarr([{ syncEnabled: true }]);
    const mediaRepository = getRepository(Media);

    const oneSeasonShow = (id: number): TmdbTvDetails =>
      fakeTmdbShow(id, [
        {
          id: 1,
          air_date: '2024-01-01',
          episode_count: 10,
          name: 'Season 1',
          overview: '',
          season_number: 1,
        },
      ]);
    getShowByTvdbIdImpl = async ({ tvdbId }) => oneSeasonShow(tvdbId);
    getTvShowImpl = async ({ tvId }) => oneSeasonShow(tvId);

    const media = new Media();
    media.tmdbId = 600;
    media.tvdbId = 12345;
    media.mediaType = MediaType.TV;
    media.status = MediaStatus.PROCESSING;
    media.serviceId = 0;
    media.externalServiceId = 1;
    media.seasons = [
      new Season({
        seasonNumber: 1,
        status: MediaStatus.PROCESSING,
        status4k: MediaStatus.UNKNOWN,
      }),
    ];
    await mediaRepository.save(media);

    // 5 of 10 episodes present.
    getSeriesByIdImpl = async () => fakeSonarrSeries({ 1: 5 }, 1);

    await availabilityCheck.run();

    const updated = await mediaRepository.findOneOrFail({
      where: { tmdbId: 600 },
      relations: ['seasons'],
    });
    assert.strictEqual(updated.status, MediaStatus.PARTIALLY_AVAILABLE);
  });

  // (d) *arr 404 / unresolvable -> skipped, loop continues, no throw.
  it('continues without throwing when the *arr lookup fails', async () => {
    configureRadarr([{ syncEnabled: true }]);
    const mediaRepository = getRepository(Media);

    const failing = new Media();
    failing.tmdbId = 700;
    failing.mediaType = MediaType.MOVIE;
    failing.status = MediaStatus.PROCESSING;
    failing.serviceId = 0;
    failing.externalServiceId = 99;
    await mediaRepository.save(failing);

    const ok = new Media();
    ok.tmdbId = 701;
    ok.mediaType = MediaType.MOVIE;
    ok.status = MediaStatus.PROCESSING;
    ok.serviceId = 0;
    ok.externalServiceId = 1;
    await mediaRepository.save(ok);

    getMovieImpl = async ({ id }) => {
      if (id === 99) {
        throw new Error('404');
      }
      return fakeRadarrMovie({ tmdbId: 701, hasFile: true });
    };

    await availabilityCheck.run();

    const failingUpdated = await mediaRepository.findOneOrFail({
      where: { tmdbId: 700 },
    });
    const okUpdated = await mediaRepository.findOneOrFail({
      where: { tmdbId: 701 },
    });
    // Failing item is untouched; the loop still processed the next item.
    assert.strictEqual(failingUpdated.status, MediaStatus.PROCESSING);
    assert.strictEqual(okUpdated.status, MediaStatus.AVAILABLE);
  });

  // (e) availability check skipped when the scanner status().running is true.
  it('does not check availability when a full scan is already running', async () => {
    configureRadarr([{ syncEnabled: true }]);
    const mediaRepository = getRepository(Media);

    const media = new Media();
    media.tmdbId = 800;
    media.mediaType = MediaType.MOVIE;
    media.status = MediaStatus.PROCESSING;
    media.serviceId = 0;
    media.externalServiceId = 1;
    await mediaRepository.save(media);

    let movieFetched = false;
    getMovieImpl = async () => {
      movieFetched = true;
      return fakeRadarrMovie({ tmdbId: 800, hasFile: true });
    };

    (radarrScanner as unknown as { running: boolean }).running = true;
    try {
      await availabilityCheck.run();
    } finally {
      (radarrScanner as unknown as { running: boolean }).running = false;
    }

    const updated = await mediaRepository.findOneOrFail({
      where: { tmdbId: 800 },
    });
    assert.strictEqual(movieFetched, false, 'should not query Radarr');
    assert.strictEqual(updated.status, MediaStatus.PROCESSING);
  });

  // (f) PENDING / BLOCKLISTED / DELETED rows are not loaded.
  it('does not load PENDING, BLOCKLISTED, or DELETED media', async () => {
    configureRadarr([{ syncEnabled: true }]);
    const mediaRepository = getRepository(Media);

    for (const [tmdbId, status] of [
      [900, MediaStatus.PENDING],
      [901, MediaStatus.BLOCKLISTED],
      [902, MediaStatus.DELETED],
    ] as [number, MediaStatus][]) {
      const media = new Media();
      media.tmdbId = tmdbId;
      media.mediaType = MediaType.MOVIE;
      media.status = status;
      media.serviceId = 0;
      media.externalServiceId = 1;
      await mediaRepository.save(media);
    }

    let fetched = false;
    getMovieImpl = async () => {
      fetched = true;
      return fakeRadarrMovie({ hasFile: true });
    };

    await availabilityCheck.run();

    assert.strictEqual(fetched, false, 'no excluded row should be checked');

    const pending = await mediaRepository.findOneOrFail({
      where: { tmdbId: 900 },
    });
    const blocklisted = await mediaRepository.findOneOrFail({
      where: { tmdbId: 901 },
    });
    const deleted = await mediaRepository.findOneOrFail({
      where: { tmdbId: 902 },
    });
    assert.strictEqual(pending.status, MediaStatus.PENDING);
    assert.strictEqual(blocklisted.status, MediaStatus.BLOCKLISTED);
    assert.strictEqual(deleted.status, MediaStatus.DELETED);
  });

  // (g) only upgrades; never downgrades/deletes, and respects syncEnabled=false.
  it('skips media whose linked server has syncEnabled=false (no downgrade)', async () => {
    configureRadarr([{ syncEnabled: false }]);
    const mediaRepository = getRepository(Media);

    const media = new Media();
    media.tmdbId = 1000;
    media.mediaType = MediaType.MOVIE;
    media.status = MediaStatus.PROCESSING;
    media.serviceId = 0;
    media.externalServiceId = 1;
    await mediaRepository.save(media);

    let fetched = false;
    getMovieImpl = async () => {
      fetched = true;
      return fakeRadarrMovie({ tmdbId: 1000, hasFile: false });
    };

    await availabilityCheck.run();

    const updated = await mediaRepository.findOneOrFail({
      where: { tmdbId: 1000 },
    });
    assert.strictEqual(fetched, false, 'sync-disabled server must be skipped');
    assert.strictEqual(updated.status, MediaStatus.PROCESSING);
  });

  // (h) includeDisabledServers=true -> media on a syncEnabled=false server IS
  // checked and flipped; reverting the flag restores the default skip behavior.
  it('checks media on a syncEnabled=false server when includeDisabledServers is enabled', async () => {
    const settings = getSettings();
    const previousIncludeDisabledServers = settings.main.includeDisabledServers;
    configureRadarr([{ syncEnabled: false }]);
    const mediaRepository = getRepository(Media);

    const media = new Media();
    media.tmdbId = 1100;
    media.mediaType = MediaType.MOVIE;
    media.status = MediaStatus.PROCESSING;
    media.serviceId = 0;
    media.externalServiceId = 1;
    await mediaRepository.save(media);

    let fetched = false;
    getMovieImpl = async () => {
      fetched = true;
      return fakeRadarrMovie({ tmdbId: 1100, hasFile: true });
    };

    settings.main.includeDisabledServers = true;
    try {
      await availabilityCheck.run();
    } finally {
      settings.main.includeDisabledServers = previousIncludeDisabledServers;
    }

    const updated = await mediaRepository.findOneOrFail({
      where: { tmdbId: 1100 },
    });
    assert.strictEqual(
      fetched,
      true,
      'sync-disabled server must be checked when includeDisabledServers is enabled'
    );
    assert.strictEqual(updated.status, MediaStatus.AVAILABLE);
  });
});
