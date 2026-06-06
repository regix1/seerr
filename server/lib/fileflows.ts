import FileFlowsAPI from '@server/api/fileflows';
import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';

// FileFlows exposes no title/TMDB metadata on its files (its OriginalMetadata/
// FinalMetadata are codec/resolution only), so the release name is the sole
// mapping signal — resolved through the Radarr/Sonarr parser.
type MappingSource = 'arr-parse' | 'none';

// A processing file resolved to a media item via the Radarr/Sonarr release
// parser. `key` is the held-media key (`tmdb:`/`tvdb:`) or null when the file
// could not be resolved.
interface ResolvedFile {
  key: string | null;
  mediaType: 'movie' | 'tv' | null;
  tmdbId: number | null;
  tvdbId: number | null;
  title: string | null;
  source: MappingSource;
  // TV granularity parsed from the file name, so the hold (and badge) can be
  // marked per season and per episode, not only series-wide.
  seasons?: number[];
  episodes?: { season: number; episode: number }[];
}

export interface FileFlowsFileMapping {
  file: string;
  title: string | null;
  mediaType: 'movie' | 'tv' | null;
  tmdbId: number | null;
  tvdbId: number | null;
  source: MappingSource;
  badgeActive: boolean;
}

// How long a successful /api/status result is reused before re-fetching.
// Concurrent callers within a run are still deduped via `inFlight`; this short
// TTL keeps the live processing percent reasonably current for the UI badge.
const CACHE_TTL_MS = 3 * 1000;
// If FileFlows stays unreachable longer than this, the last-good cache is
// discarded so a FileFlows outage can't block "available" notifications forever
// (fail-open). Brief blips reuse the previous cache (fail-closed / keep gating).
const STALE_LIMIT_MS = 10 * 60 * 1000;
// A media item stays flagged as "held by FileFlows" (for the UI badge and the
// availability deferral) for this long after it was last marked. The
// fileflows-sync job re-marks active holds every ~60s (and the media routes
// far more often while a page is open), so this is comfortably above the
// re-mark cadence — no flicker mid-processing — while keeping the release after
// FileFlows finishes reasonably prompt. The hold is only ever renewed by a
// *fresh* processing signal, never by its own held state, so it does expire.
const HELD_TTL_MS = 3 * 60 * 1000;

const basename = (p: string): string =>
  p.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';

const stem = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
};

/**
 * Tracks which files FileFlows is currently processing so callers can avoid
 * treating media as "available" while it is still being post-processed.
 *
 * Matching is by file basename / stem and by path segment (folder name) rather
 * than by full path, because the paths FileFlows reports are from its own
 * mount/container perspective and rarely share a prefix with Sonarr/Radarr's.
 */
class FileFlowsProcessingTracker {
  private basenames = new Set<string>();
  private stems = new Set<string>();
  private folders = new Set<string>();
  private fetchedAt = 0;
  private lastGoodAt = 0;
  private heldMedia = new Map<string, number>();
  private inFlight: Promise<void> | null = null;
  private currentFiles: string[] = [];
  private processingCount = 0;
  private queueCount = 0;
  // Per-file movie-vs-tv hint from FileFlows' library name, keyed by lowercased
  // basename, rebuilt on every status refresh.
  private libraryHints = new Map<string, 'movie' | 'tv' | null>();
  // Per-file FileFlows step percent (0-100), keyed by lowercased basename,
  // rebuilt on every status refresh.
  private fileProgress = new Map<string, number>();
  // Latest known progress per held media key, so the UI badge can show a live
  // percent. Expires together with the held mark.
  private heldProgress = new Map<string, number>();
  // Cache resolved files (positive results only) so we parse a given file at
  // most once while it is processing.
  private resolveCache = new Map<string, ResolvedFile>();

  private get isEnabled(): boolean {
    const { enabled, hostname } = getSettings().fileflows;
    return enabled && !!hostname;
  }

  private addPath(rawPath: string): void {
    if (!rawPath) {
      return;
    }
    const parts = rawPath.replace(/\\/g, '/').split('/').filter(Boolean);
    const base = parts[parts.length - 1] ?? '';
    if (base) {
      this.basenames.add(base.toLowerCase());
      this.stems.add(stem(base).toLowerCase());
    }
    // Track parent folder names too — a release usually sits in a folder named
    // after the release, which matches the *arr download-queue title even when
    // the file inside has been renamed.
    for (const segment of parts.slice(0, -1)) {
      this.folders.add(segment.toLowerCase());
    }
  }

  private async refresh(): Promise<void> {
    if (!this.isEnabled) {
      this.clear();
      return;
    }

    if (Date.now() - this.fetchedAt < CACHE_TTL_MS) {
      return;
    }

    // Dedupe concurrent refreshes: a scan can call this for many items at once,
    // and fetchedAt isn't updated until the request resolves — without this
    // guard every concurrent caller would fire its own /api/status request.
    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.fetchStatus().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async fetchStatus(): Promise<void> {
    try {
      const settings = getSettings().fileflows;
      const api = new FileFlowsAPI(settings);
      const status = await api.getStatus();

      this.basenames = new Set();
      this.stems = new Set();
      this.folders = new Set();
      this.currentFiles = [];
      this.libraryHints = new Map();
      this.fileProgress = new Map();
      this.processingCount = status.processing ?? 0;
      this.queueCount = status.queue ?? 0;
      for (const file of status.processingFiles ?? []) {
        this.addPath(file.name);
        this.addPath(file.relativePath ?? '');
        const name = basename(file.name || file.relativePath || '');
        if (name && !this.currentFiles.includes(name)) {
          this.currentFiles.push(name);
        }
        if (name) {
          const key = name.toLowerCase();
          this.libraryHints.set(key, libraryHint(file.library));
          if (typeof file.stepPercent === 'number') {
            this.fileProgress.set(key, clampPercent(file.stepPercent));
          }
        }
      }

      const now = Date.now();
      this.fetchedAt = now;
      this.lastGoodAt = now;
      logger.debug(
        `FileFlows reports ${
          status.processingFiles?.length ?? 0
        } file(s) processing`,
        { label: 'FileFlows' }
      );
    } catch (e) {
      this.fetchedAt = Date.now();
      // Keep the previous cache during brief outages so we don't release the
      // gate prematurely; discard it once the outage is prolonged (fail-open).
      if (Date.now() - this.lastGoodAt > STALE_LIMIT_MS) {
        this.clear();
      }
      logger.warn('Failed to query FileFlows status', {
        label: 'FileFlows',
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private clear(): void {
    this.basenames = new Set();
    this.stems = new Set();
    this.folders = new Set();
    this.currentFiles = [];
    this.libraryHints = new Map();
    this.fileProgress = new Map();
    this.processingCount = 0;
    this.queueCount = 0;
    // Release held media immediately when FileFlows is disabled or has been
    // unreachable past the stale window (fail-open), rather than waiting out the
    // per-key TTL.
    this.heldMedia = new Map();
    this.heldProgress = new Map();
  }

  /** True if FileFlows is actively processing at least one file. */
  public async hasProcessingFiles(): Promise<boolean> {
    await this.refresh();
    return this.basenames.size > 0;
  }

  /** True if the given file (matched by basename/stem) is being processed. */
  public async isFileProcessing(filePath?: string): Promise<boolean> {
    if (!filePath) {
      return false;
    }
    await this.refresh();
    if (this.basenames.size === 0) {
      return false;
    }
    const base = basename(filePath).toLowerCase();
    return this.basenames.has(base) || this.stems.has(stem(base).toLowerCase());
  }

  /**
   * True if FileFlows is processing a file matching the given release name
   * (e.g. a Radarr/Sonarr download-queue title). Queue titles have no file
   * extension, so they are matched against the processing files' stems — this
   * catches files FileFlows processes in the download folder before import.
   */
  public async isReleaseProcessing(title?: string): Promise<boolean> {
    if (!title) {
      return false;
    }
    await this.refresh();
    if (this.basenames.size === 0) {
      return false;
    }
    const t = title.toLowerCase();
    return this.stems.has(t) || this.basenames.has(t) || this.folders.has(t);
  }

  /**
   * Record a media item as held by FileFlows (surfaced as a UI badge). Callers
   * key by whatever id they have on hand — TMDB/TVDB id from the scanner, or
   * `radarr:`/`sonarr:` external service id from the download tracker. When the
   * FileFlows step percent for the item is known it is stored too, so the badge
   * can show live progress.
   */
  public markHeld(key: string, percent?: number | null): void {
    this.heldMedia.set(key, Date.now());
    if (typeof percent === 'number' && Number.isFinite(percent)) {
      this.heldProgress.set(key, clampPercent(percent));
    }
  }

  /** True if any of the given keys was marked as held by FileFlows recently. */
  public isHeld(...keys: (string | undefined)[]): boolean {
    for (const key of keys) {
      if (!key) {
        continue;
      }
      const markedAt = this.heldMedia.get(key);
      if (markedAt === undefined) {
        continue;
      }
      if (Date.now() - markedAt > HELD_TTL_MS) {
        this.heldMedia.delete(key);
        this.heldProgress.delete(key);
        continue;
      }
      return true;
    }
    return false;
  }

  /**
   * True if any media is still held (within the TTL). Lets the sync job keep
   * scanning for a short tail after FileFlows stops processing, so the scan that
   * runs just after the holds expire flips the media to available — without
   * clearing holds early (a brief gap between files must not release them).
   * Prunes expired entries as it goes.
   */
  public hasHeldMedia(): boolean {
    const now = Date.now();
    let held = false;
    for (const [key, markedAt] of this.heldMedia) {
      if (now - markedAt > HELD_TTL_MS) {
        this.heldMedia.delete(key);
        this.heldProgress.delete(key);
      } else {
        held = true;
      }
    }
    return held;
  }

  /**
   * FileFlows processing percent (0-100) for the first still-held key (in
   * argument order) that has a known percent, or null when unknown (e.g. held
   * via the download queue without a live percent).
   */
  public getHeldProgress(...keys: (string | undefined)[]): number | null {
    for (const key of keys) {
      if (!key || !this.isHeld(key)) {
        continue;
      }
      const percent = this.heldProgress.get(key);
      if (percent != null) {
        return percent;
      }
    }
    return null;
  }

  private async parseWithRadarr(file: string): Promise<ResolvedFile | null> {
    for (const server of getSettings().radarr) {
      if (!server.syncEnabled) {
        continue;
      }
      try {
        const radarr = new RadarrAPI({
          apiKey: server.apiKey,
          url: RadarrAPI.buildUrl(server, '/api/v3'),
        });
        const match = await radarr.getTmdbIdFromRelease(file);
        if (match) {
          return {
            key: `tmdb:${match.tmdbId}`,
            mediaType: 'movie',
            tmdbId: match.tmdbId,
            tvdbId: null,
            title: match.title,
            source: 'arr-parse',
          };
        }
      } catch {
        // try the next server
      }
    }
    return null;
  }

  private async parseWithSonarr(file: string): Promise<ResolvedFile | null> {
    for (const server of getSettings().sonarr) {
      if (!server.syncEnabled) {
        continue;
      }
      try {
        const sonarr = new SonarrAPI({
          apiKey: server.apiKey,
          url: SonarrAPI.buildUrl(server, '/api/v3'),
        });
        const match = await sonarr.getTvdbIdFromRelease(file);
        if (match) {
          return {
            key: `tvdb:${match.tvdbId}`,
            mediaType: 'tv',
            tmdbId: null,
            tvdbId: match.tvdbId,
            title: match.title,
            source: 'arr-parse',
          };
        }
      } catch {
        // try the next server
      }
    }
    return null;
  }

  // Resolve a single processing file to a media item by asking Radarr/Sonarr to
  // parse the release name. The *arr parser is scene-aware, so it resolves names
  // a plain match misses (extra tags like "-xpost", renamed files, etc.). The
  // FileFlows library name hints movie-vs-tv so the right *arr is tried first.
  private async resolveFileFull(file: string): Promise<ResolvedFile> {
    const hint = this.libraryHints.get(file.toLowerCase()) ?? null;
    const attempts =
      hint === 'tv'
        ? [() => this.parseWithSonarr(file), () => this.parseWithRadarr(file)]
        : [() => this.parseWithRadarr(file), () => this.parseWithSonarr(file)];

    for (const attempt of attempts) {
      const result = await attempt();
      if (result) {
        if (result.mediaType === 'tv') {
          const { seasons, episodes } = parseSeasonEpisode(file);
          result.seasons = seasons;
          result.episodes = episodes;
        }
        return result;
      }
    }

    return {
      key: null,
      mediaType: hint,
      tmdbId: null,
      tvdbId: null,
      title: null,
      source: 'none',
    };
  }

  /**
   * Resolve each currently-processing file to a media item and mark it held, so
   * the "processing in FileFlows" badge shows even when the download already
   * left the *arr queue. Resolved files are cached so each is parsed at most
   * once; unresolved files are retried each cycle (cheap, and lets late
   * FileFlows metadata or a newly-added *arr entry resolve them).
   */
  public async resolveHeldMedia(): Promise<void> {
    await this.refresh();

    for (const cached of this.resolveCache.keys()) {
      if (!this.currentFiles.includes(cached)) {
        this.resolveCache.delete(cached);
      }
    }

    for (const file of this.currentFiles) {
      let resolved = this.resolveCache.get(file);
      if (!resolved?.key) {
        resolved = await this.resolveFileFull(file);
        if (resolved.key) {
          this.resolveCache.set(file, resolved);
        }
      }
      if (resolved.key) {
        // Re-mark every cycle with the latest percent so the badge stays live.
        const percent = this.fileProgress.get(file.toLowerCase());
        this.markHeld(resolved.key, percent);
        // For TV, also hold at season and episode granularity so the badge can
        // surface on the season group, the season overall, and the episode row.
        if (resolved.tvdbId != null) {
          for (const season of resolved.seasons ?? []) {
            this.markHeld(`tvdb:${resolved.tvdbId}:s${season}`, percent);
          }
          for (const ep of resolved.episodes ?? []) {
            this.markHeld(
              `tvdb:${resolved.tvdbId}:s${ep.season}e${ep.episode}`,
              percent
            );
          }
        }
      }
    }
  }

  /** Diagnostic mapping of each processing file to the media it resolved to. */
  public async getFileMappings(): Promise<{
    processing: number;
    queue: number;
    files: FileFlowsFileMapping[];
  }> {
    await this.resolveHeldMedia();

    const files: FileFlowsFileMapping[] = this.currentFiles.map((file) => {
      // resolveHeldMedia caches positives; unresolved files fall back to the
      // library hint so the view can still show movie-vs-tv.
      const resolved: ResolvedFile = this.resolveCache.get(file) ?? {
        key: null,
        mediaType: this.libraryHints.get(file.toLowerCase()) ?? null,
        tmdbId: null,
        tvdbId: null,
        title: null,
        source: 'none',
      };
      return {
        file,
        title: resolved.title,
        mediaType: resolved.mediaType,
        tmdbId: resolved.tmdbId,
        tvdbId: resolved.tvdbId,
        source: resolved.source,
        badgeActive: resolved.key ? this.isHeld(resolved.key) : false,
      };
    });

    return {
      processing: this.processingCount,
      queue: this.queueCount,
      files,
    };
  }
}

// Clamp a FileFlows step percent to a whole 0-100.
function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

// Extract season + episode numbers from a release file name. Handles single
// (S05E08), multi-episode (S01E01E02 / S02E05-E06) and season-pack (Season 5 /
// S05) forms. Returns the seasons touched and a flat list of episodes.
//
// Numbers follow the release/TVDB scheme. For standard shows this matches the
// TMDB season/episode numbering the details page keys against, so the per-season
// and per-episode badges line up. For anime or shows with divergent season
// splits the two can differ, in which case the granular badge may land on the
// wrong season/episode (or not show) — the series-level badge is unaffected.
function parseSeasonEpisode(name: string): {
  seasons: number[];
  episodes: { season: number; episode: number }[];
} {
  const seasons = new Set<number>();
  const episodes: { season: number; episode: number }[] = [];
  const match = name.match(/s(\d{1,3})\s*((?:e\d{1,4}[\s._-]*)+)/i);
  if (match) {
    const season = parseInt(match[1], 10);
    seasons.add(season);
    for (const ep of match[2].matchAll(/e(\d{1,4})/gi)) {
      episodes.push({ season, episode: parseInt(ep[1], 10) });
    }
  } else {
    // Season pack with no explicit episodes ("Season 5" / "S05").
    const pack = name.match(/\b(?:season[\s._-]*|s)(\d{1,3})\b/i);
    if (pack) {
      seasons.add(parseInt(pack[1], 10));
    }
  }
  return { seasons: [...seasons], episodes };
}

// Map a FileFlows library name ("Movie: Video Library", "TV Show: Video
// Library", …) to a movie-vs-tv hint so the right *arr is parsed first.
function libraryHint(library?: string): 'movie' | 'tv' | null {
  if (!library) {
    return null;
  }
  const l = library.toLowerCase();
  if (
    l.includes('tv') ||
    l.includes('show') ||
    l.includes('series') ||
    l.includes('episode')
  ) {
    return 'tv';
  }
  if (l.includes('movie') || l.includes('film')) {
    return 'movie';
  }
  return null;
}

const fileFlowsTracker = new FileFlowsProcessingTracker();

export default fileFlowsTracker;
