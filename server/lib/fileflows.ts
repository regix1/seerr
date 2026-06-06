import FileFlowsAPI, { type FileFlowsMetaInfo } from '@server/api/fileflows';
import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';

type MappingSource = 'fileflows' | 'arr-parse' | 'none';

// FileFlows' own resolved metadata for a processing file (from a Movie/TV
// lookup node). tmdbId is null when FileFlows reported only a title or a
// non-numeric id.
interface FileFlowsMeta {
  tmdbId: number | null;
  mediaType: 'movie' | 'tv' | null;
  title: string | null;
}

// A processing file resolved to a media item via FileFlows metadata or the
// Radarr/Sonarr release parser. `key` is the held-media key (`tmdb:`/`tvdb:`)
// or null when the file could not be resolved.
interface ResolvedFile {
  key: string | null;
  mediaType: 'movie' | 'tv' | null;
  tmdbId: number | null;
  tvdbId: number | null;
  title: string | null;
  source: MappingSource;
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

// How long a successful /api/status result is reused before re-fetching. A
// scanner processes many items per run; this keeps it to ~one request per run.
const CACHE_TTL_MS = 30 * 1000;
// If FileFlows stays unreachable longer than this, the last-good cache is
// discarded so a FileFlows outage can't block "available" notifications forever
// (fail-open). Brief blips reuse the previous cache (fail-closed / keep gating).
const STALE_LIMIT_MS = 10 * 60 * 1000;
// A media item stays flagged as "held by FileFlows" (for the UI badge) for this
// long after it was last marked. The fileflows-sync job re-marks active holds
// well within this window; once FileFlows finishes, the mark simply expires.
const HELD_TTL_MS = 5 * 60 * 1000;

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
  // FileFlows' own per-file metadata, keyed by lowercased basename, rebuilt on
  // every status refresh.
  private metaByBasename = new Map<string, FileFlowsMeta>();
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
      this.metaByBasename = new Map();
      this.processingCount = status.processing ?? 0;
      this.queueCount = status.queue ?? 0;
      for (const file of status.processingFiles ?? []) {
        this.addPath(file.name);
        this.addPath(file.relativePath ?? '');
        const name = basename(file.name || file.relativePath || '');
        if (name && !this.currentFiles.includes(name)) {
          this.currentFiles.push(name);
        }
      }

      // Best-effort: enrich with FileFlows' own metadata (title / TMDB id) when
      // a lookup node populated it. A failure here (older build, route absent)
      // must not discard the status result captured above.
      try {
        const libraryFiles = await api.getProcessingLibraryFiles();
        for (const lf of libraryFiles) {
          const base = basename(lf.Name || lf.RelativePath || '').toLowerCase();
          const meta = this.resolveFromMeta(lf.MetaInfo);
          if (base && meta) {
            this.metaByBasename.set(base, meta);
          }
        }
      } catch (e) {
        logger.debug('FileFlows library-file metadata unavailable', {
          label: 'FileFlows',
          errorMessage: e instanceof Error ? e.message : String(e),
        });
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
    this.metaByBasename = new Map();
    this.processingCount = 0;
    this.queueCount = 0;
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
   * `radarr:`/`sonarr:` external service id from the download tracker.
   */
  public markHeld(key: string): void {
    this.heldMedia.set(key, Date.now());
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
        continue;
      }
      return true;
    }
    return false;
  }

  // Parse FileFlows' MetaInfo into a usable mapping. Returns null only when the
  // metadata carries neither a title nor a usable id (nothing to surface).
  private resolveFromMeta(
    meta?: FileFlowsMetaInfo | null
  ): FileFlowsMeta | null {
    if (!meta) {
      return null;
    }
    const tmdbId = numericId(meta.MetaId);
    const title = meta.Title?.trim() || null;
    if (!tmdbId && !title) {
      return null;
    }
    // FileFlows only fills SeasonNumber/EpisodeNumber for TV; presence of either
    // is a reliable movie-vs-tv signal that doesn't depend on enum ordering.
    const isTv = meta.SeasonNumber != null || meta.EpisodeNumber != null;
    return { tmdbId, mediaType: isTv ? 'tv' : 'movie', title };
  }

  // Resolve a single processing file to a media item. Prefers FileFlows' own
  // metadata (no extra network call); otherwise asks each Radarr/Sonarr server
  // to parse the release name. The *arr parser is scene-aware, so it resolves
  // names a plain match misses (extra tags like "-xpost", renamed files, etc.).
  private async resolveFileFull(file: string): Promise<ResolvedFile> {
    const meta = this.metaByBasename.get(file.toLowerCase());

    if (meta?.tmdbId) {
      return {
        key: `tmdb:${meta.tmdbId}`,
        mediaType: meta.mediaType ?? 'movie',
        tmdbId: meta.tmdbId,
        tvdbId: null,
        title: meta.title,
        source: 'fileflows',
      };
    }

    const settings = getSettings();

    for (const server of settings.radarr) {
      if (!server.syncEnabled) {
        continue;
      }
      try {
        const radarr = new RadarrAPI({
          apiKey: server.apiKey,
          url: RadarrAPI.buildUrl(server, '/api/v3'),
        });
        const tmdbId = await radarr.getTmdbIdFromRelease(file);
        if (tmdbId) {
          return {
            key: `tmdb:${tmdbId}`,
            mediaType: 'movie',
            tmdbId,
            tvdbId: null,
            title: meta?.title ?? null,
            source: 'arr-parse',
          };
        }
      } catch {
        // try the next server
      }
    }

    for (const server of settings.sonarr) {
      if (!server.syncEnabled) {
        continue;
      }
      try {
        const sonarr = new SonarrAPI({
          apiKey: server.apiKey,
          url: SonarrAPI.buildUrl(server, '/api/v3'),
        });
        const tvdbId = await sonarr.getTvdbIdFromRelease(file);
        if (tvdbId) {
          return {
            key: `tvdb:${tvdbId}`,
            mediaType: 'tv',
            tmdbId: null,
            tvdbId,
            title: meta?.title ?? null,
            source: 'arr-parse',
          };
        }
      } catch {
        // try the next server
      }
    }

    // Unresolved — still surface any FileFlows title for the diagnostic view.
    return {
      key: null,
      mediaType: meta?.mediaType ?? null,
      tmdbId: null,
      tvdbId: null,
      title: meta?.title ?? null,
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
        this.markHeld(resolved.key);
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
      // resolveHeldMedia caches positives; unresolved files fall back to any
      // FileFlows metadata so the view can still show what FileFlows thinks it
      // is even when nothing mapped it to an id.
      const meta = this.metaByBasename.get(file.toLowerCase());
      const resolved: ResolvedFile = this.resolveCache.get(file) ?? {
        key: null,
        mediaType: meta?.mediaType ?? null,
        tmdbId: null,
        tvdbId: null,
        title: meta?.title ?? null,
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

// A FileFlows MetaId is treated as a TMDB id only when it is a clean positive
// integer; FileFlows may instead expose an IMDb-style id ("tt123…") or nothing,
// in which case the *arr parser is the authoritative resolver.
function numericId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

const fileFlowsTracker = new FileFlowsProcessingTracker();

export default fileFlowsTracker;
