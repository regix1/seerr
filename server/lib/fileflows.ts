import FileFlowsAPI from '@server/api/fileflows';
import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import type { FileFlowsFlowStepTotal } from '@server/models/FileFlows';
import {
  buildFileFlowsProcessingSnapshot,
  clampFileFlowsPercent,
  FileFlowsFileStatus,
  FileFlowsModelError,
  resolveFileFlowsFlowStepTotal,
} from '@server/models/FileFlows';

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
// Flow step totals change only when a flow is edited — refresh at most once per
// minute per library while status polling stays at CACHE_TTL_MS.
const FLOW_STEP_TOTAL_TTL_MS = 60 * 1000;
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

// The parent folder of a path — usually the release folder a download sits in.
// When the file itself was renamed (e.g. a scene group prefix like "sr-…"), the
// folder still carries the clean release name, which the *arr parsers resolve.
const parentFolder = (p: string): string => {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : '';
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
  // Per-file parent (release) folder name, keyed by lowercased basename, rebuilt
  // on every status refresh. Used as a second parse candidate so a renamed file
  // can still resolve via its clean release-folder name.
  private fileFolder = new Map<string, string>();
  // Per-file FileFlows step percent (0-100), keyed by lowercased basename,
  // rebuilt on every status refresh.
  private fileProgress = new Map<string, number>();
  // Per-file monotonic overall percent — never decreases while a file is active.
  private fileMonotonicProgress = new Map<string, number>();
  // Flow step totals keyed by library uid — refreshed from the API (see TTL).
  private flowStepTotals = new Map<string, FileFlowsFlowStepTotal>();
  private flowStepTotalsFetchedAt = new Map<string, number>();
  // Latest known progress per held media key, so the UI badge can show a live
  // percent. Expires together with the held mark.
  private heldProgress = new Map<string, number>();
  // Cache resolved files (positive results only) so we parse a given file at
  // most once while it is processing.
  private resolveCache = new Map<string, ResolvedFile>();
  // Media keys last refreshed by resolveHeldMedia — used to release holds as
  // soon as a file leaves the FileFlows queue instead of waiting out the TTL.
  private resolverLiveKeys = new Set<string>();

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
      this.fileFolder = new Map();
      this.fileProgress = new Map();
      this.processingCount = status.processing ?? 0;
      this.queueCount = status.queue ?? 0;

      // Match active files to library-file records so ExecutedNodes can drive a
      // single 0→100 overall percent (stepPercent alone is per-node only).
      let libraryFiles: Awaited<ReturnType<FileFlowsAPI['getLibraryFiles']>> =
        [];
      try {
        libraryFiles = await api.getLibraryFiles(
          FileFlowsFileStatus.Processing
        );
      } catch (e) {
        logger.warn('Failed to list FileFlows processing library files', {
          label: 'FileFlows',
          errorMessage: e instanceof Error ? e.message : String(e),
        });
      }

      const detailByBasename = new Map<
        string,
        Awaited<ReturnType<FileFlowsAPI['getLibraryFile']>>
      >();
      await Promise.all(
        (status.processingFiles ?? []).map(async (file) => {
          const fullPath = file.name || file.relativePath || '';
          const name = basename(fullPath);
          if (!name) {
            return;
          }
          const uid = findLibraryFileUid(name, libraryFiles);
          if (!uid) {
            logger.debug(
              `No library-file list match for processing file ${name}`,
              { label: 'FileFlows' }
            );
            return;
          }
          try {
            detailByBasename.set(
              name.toLowerCase(),
              await api.getLibraryFile(uid)
            );
          } catch (e) {
            logger.warn(`Failed to fetch library-file detail for ${name}`, {
              label: 'FileFlows',
              errorMessage: e instanceof Error ? e.message : String(e),
            });
          }
        })
      );

      const libraryUids = [
        ...new Set(
          [...detailByBasename.values()]
            .map((d) => d.LibraryUid)
            .filter((uid): uid is string => !!uid)
        ),
      ];
      await this.refreshFlowStepTotals(api, libraryUids);

      for (const file of status.processingFiles ?? []) {
        this.addPath(file.name);
        this.addPath(file.relativePath ?? '');
        const fullPath = file.name || file.relativePath || '';
        const name = basename(fullPath);
        if (name && !this.currentFiles.includes(name)) {
          this.currentFiles.push(name);
        }
        if (name) {
          const key = name.toLowerCase();
          this.libraryHints.set(key, libraryHint(file.library));
          const folder = parentFolder(fullPath);
          if (folder && folder.toLowerCase() !== key) {
            this.fileFolder.set(key, folder);
          }
          const detail = detailByBasename.get(key);
          if (!detail?.LibraryUid) {
            continue;
          }
          const stepTotal = this.flowStepTotals.get(detail.LibraryUid);
          if (!stepTotal) {
            logger.debug(
              `No flow step total for library ${detail.LibraryUid}; badge will show spinner only`,
              { label: 'FileFlows', file: name }
            );
            continue;
          }
          try {
            const snapshot = buildFileFlowsProcessingSnapshot({
              fileBasename: name,
              detail,
              statusFile: file,
              stepTotal,
              previousOverallPercent: this.fileMonotonicProgress.get(key),
            });
            this.fileMonotonicProgress.set(key, snapshot.overallPercent);
            this.fileProgress.set(key, snapshot.overallPercent);
          } catch (e) {
            const message =
              e instanceof FileFlowsModelError
                ? e.message
                : e instanceof Error
                  ? e.message
                  : String(e);
            logger.warn(
              `Could not build FileFlows progress snapshot for ${name}`,
              { label: 'FileFlows', errorMessage: message }
            );
          }
        }
      }

      const activeKeys = new Set(this.currentFiles.map((f) => f.toLowerCase()));
      for (const key of this.fileMonotonicProgress.keys()) {
        if (!activeKeys.has(key)) {
          this.fileMonotonicProgress.delete(key);
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
    this.fileFolder = new Map();
    this.fileProgress = new Map();
    this.processingCount = 0;
    this.queueCount = 0;
    // Release held media immediately when FileFlows is disabled or has been
    // unreachable past the stale window (fail-open), rather than waiting out the
    // per-key TTL.
    this.heldMedia = new Map();
    this.heldProgress = new Map();
    this.fileMonotonicProgress = new Map();
    this.flowStepTotals = new Map();
    this.flowStepTotalsFetchedAt = new Map();
    this.resolveCache = new Map();
    this.resolverLiveKeys = new Set();
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
    // `undefined` means the caller has no opinion on the percent (e.g. a hold from
    // the *arr download queue) — leave any existing percent untouched. A value
    // (including `null`) is authoritative: store it, or clear when the file
    // leaves the FileFlows queue and resolveHeldMedia passes null.
    if (percent !== undefined) {
      if (typeof percent === 'number' && Number.isFinite(percent)) {
        this.heldProgress.set(key, clampFileFlowsPercent(percent));
      } else {
        this.heldProgress.delete(key);
      }
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
   * True if any media is still held (within the TTL). Resolver-managed keys are
   * released immediately when a file leaves the queue (see
   * releaseStaleResolverHolds); scanner/download-tracker keys still expire here.
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

  /** Clear live progress for keys that were not refreshed this resolve cycle. */
  private releaseHeld(key: string): void {
    this.heldMedia.delete(key);
    this.heldProgress.delete(key);
  }

  /**
   * Drop resolver-managed holds as soon as a file leaves the FileFlows queue.
   * Without this, heldMedia survives up to HELD_TTL_MS after processing ends,
   * so the badge can still read "FileFlows Processing" after the available
   * notification has already fired.
   */
  private releaseStaleResolverHolds(liveKeys: Set<string>): void {
    for (const key of this.resolverLiveKeys) {
      if (!liveKeys.has(key)) {
        this.releaseHeld(key);
      }
    }
    this.resolverLiveKeys = liveKeys;
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
  private async resolveFileFull(
    file: string,
    folder?: string
  ): Promise<ResolvedFile> {
    const hint = this.libraryHints.get(file.toLowerCase()) ?? null;
    // Parse candidates in order of reliability: the file name first (it carries
    // SxxExx for TV granularity), then the parent release folder — which is
    // often the clean scene name when the file itself was renamed (e.g. a group
    // prefix like "sr-…" that breaks the parser). Dedupe case-insensitively.
    const candidates: string[] = [];
    const seen = new Set<string>();
    for (const candidate of [file, folder]) {
      if (candidate && !seen.has(candidate.toLowerCase())) {
        seen.add(candidate.toLowerCase());
        candidates.push(candidate);
      }
    }

    const parsers =
      hint === 'tv'
        ? [
            (c: string) => this.parseWithSonarr(c),
            (c: string) => this.parseWithRadarr(c),
          ]
        : [
            (c: string) => this.parseWithRadarr(c),
            (c: string) => this.parseWithSonarr(c),
          ];

    for (const parse of parsers) {
      for (const candidate of candidates) {
        const result = await parse(candidate);
        if (result) {
          if (result.mediaType === 'tv') {
            // Prefer the file name for episode granularity (the folder may be a
            // season pack); fall back to the folder when the file name has none.
            const fromFile = parseSeasonEpisode(file);
            const { seasons, episodes } = fromFile.seasons.length
              ? fromFile
              : parseSeasonEpisode(folder ?? '');
            result.seasons = seasons;
            result.episodes = episodes;
          }
          return result;
        }
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

    const liveKeys = new Set<string>();

    for (const file of this.currentFiles) {
      let resolved = this.resolveCache.get(file);
      if (!resolved?.key) {
        const folder = this.fileFolder.get(file.toLowerCase());
        resolved = await this.resolveFileFull(file, folder);
        if (resolved.key) {
          this.resolveCache.set(file, resolved);
        }
      }
      if (resolved.key) {
        // Re-mark every cycle so the badge stays live. Overall percent is derived
        // from ExecutedNodes + the current node's stepPercent so the bar runs
        // once from 0→100 across the whole flow (see fetchStatus). When the file
        // leaves the FileFlows queue, releaseStaleResolverHolds clears the hold
        // immediately so the badge doesn't outlive the available notification.
        const fileKey = file.toLowerCase();
        const percent = this.fileProgress.get(fileKey) ?? null;
        this.markHeld(resolved.key, percent);
        liveKeys.add(resolved.key);
        // For TV, also hold at season and episode granularity so the badge can
        // surface on the season group, the season overall, and the episode row.
        if (resolved.tvdbId != null) {
          for (const season of resolved.seasons ?? []) {
            const seasonKey = `tvdb:${resolved.tvdbId}:s${season}`;
            this.markHeld(seasonKey, percent);
            liveKeys.add(seasonKey);
          }
          for (const ep of resolved.episodes ?? []) {
            const epKey = `tvdb:${resolved.tvdbId}:s${ep.season}e${ep.episode}`;
            this.markHeld(epKey, percent);
            liveKeys.add(epKey);
          }
        }
      }
    }

    this.releaseStaleResolverHolds(liveKeys);
  }

  /**
   * Pull the flow step total from FileFlows on each status refresh: find one
   * processed file in the same library and use its ExecutedNodes.length (the
   * flow graph Part count is much lower and not usable for overall percent).
   */
  private async refreshFlowStepTotals(
    api: FileFlowsAPI,
    libraryUids: string[]
  ): Promise<void> {
    const now = Date.now();
    const due = libraryUids.filter((libraryUid) => {
      const fetchedAt = this.flowStepTotalsFetchedAt.get(libraryUid) ?? 0;
      return (
        !this.flowStepTotals.has(libraryUid) ||
        now - fetchedAt >= FLOW_STEP_TOTAL_TTL_MS
      );
    });

    await Promise.all(
      due.map(async (libraryUid) => {
        try {
          const stepTotal = await resolveFileFlowsFlowStepTotal(
            api,
            libraryUid
          );
          this.flowStepTotals.set(libraryUid, stepTotal);
          this.flowStepTotalsFetchedAt.set(libraryUid, now);
        } catch (e) {
          this.flowStepTotals.delete(libraryUid);
          this.flowStepTotalsFetchedAt.delete(libraryUid);
          logger.warn(
            `Failed to resolve flow step total for library ${libraryUid}`,
            {
              label: 'FileFlows',
              errorMessage: e instanceof Error ? e.message : String(e),
            }
          );
        }
      })
    );
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

function findLibraryFileUid(
  fileBasename: string,
  libraryFiles: { Uid: string; Name?: string }[]
): string | null {
  const base = fileBasename.toLowerCase();
  for (const entry of libraryFiles) {
    if (basename(entry.Name ?? '').toLowerCase() === base) {
      return entry.Uid;
    }
  }
  for (const entry of libraryFiles) {
    const path = entry.Name?.replace(/\\/g, '/').toLowerCase() ?? '';
    if (path.endsWith(`/${base}`)) {
      return entry.Uid;
    }
  }
  return null;
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
