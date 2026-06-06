import FileFlowsAPI from '@server/api/fileflows';
import type { MediaType } from '@server/constants/media';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';

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
  private fetchedAt = 0;
  private lastGoodAt = 0;
  private heldMedia = new Map<string, number>();

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
  }

  private async refresh(): Promise<void> {
    if (!this.isEnabled) {
      this.clear();
      return;
    }

    if (Date.now() - this.fetchedAt < CACHE_TTL_MS) {
      return;
    }

    try {
      const settings = getSettings().fileflows;
      const api = new FileFlowsAPI(settings);
      const status = await api.getStatus();

      this.basenames = new Set();
      this.stems = new Set();
      for (const file of status.processingFiles ?? []) {
        this.addPath(file.name);
        this.addPath(file.relativePath ?? '');
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
   * Record that a media item is currently being held back because FileFlows is
   * still processing it. Surfaced to the UI as a "processing in FileFlows"
   * badge. Keyed by TMDB id for movies and TVDB id for series.
   */
  public markMediaHeld(mediaType: MediaType, id: number): void {
    this.heldMedia.set(`${mediaType}:${id}`, Date.now());
  }

  /** True if the media item was marked as held by FileFlows recently. */
  public isMediaHeld(mediaType: MediaType, id?: number): boolean {
    if (id === undefined) {
      return false;
    }
    const key = `${mediaType}:${id}`;
    const markedAt = this.heldMedia.get(key);
    if (markedAt === undefined) {
      return false;
    }
    if (Date.now() - markedAt > HELD_TTL_MS) {
      this.heldMedia.delete(key);
      return false;
    }
    return true;
  }
}

const fileFlowsTracker = new FileFlowsProcessingTracker();

export default fileFlowsTracker;
