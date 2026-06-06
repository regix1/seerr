import FileFlowsAPI from '@server/api/fileflows';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import downloadTracker from '@server/lib/downloadtracker';
import fileFlowsTracker from '@server/lib/fileflows';
import { getSettings, type FileFlowsSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { Router } from 'express';

const fileflowsRoutes = Router();

fileflowsRoutes.get('/', (_req, res) => {
  const settings = getSettings();
  res.status(200).json(settings.fileflows);
});

fileflowsRoutes.post('/', async (req, res) => {
  const settings = getSettings();
  const body = req.body as Partial<FileFlowsSettings>;

  // Whitelist known fields to avoid arbitrary settings injection.
  settings.fileflows = {
    enabled: body.enabled ?? settings.fileflows.enabled,
    hostname: body.hostname ?? settings.fileflows.hostname,
    port: body.port ?? settings.fileflows.port,
    useSsl: body.useSsl ?? settings.fileflows.useSsl,
    apiKey: body.apiKey ?? settings.fileflows.apiKey,
    urlBase: body.urlBase ?? settings.fileflows.urlBase,
  };
  await settings.save();

  res.status(200).json(settings.fileflows);
});

fileflowsRoutes.post('/test', async (req, res) => {
  try {
    const body = req.body as FileFlowsSettings;

    if (!body.hostname) {
      return res.status(400).json({ message: 'A hostname is required.' });
    }

    const fileFlows = new FileFlowsAPI({
      hostname: body.hostname,
      port: body.port,
      useSsl: body.useSsl,
      apiKey: body.apiKey,
      urlBase: body.urlBase,
    });
    const status = await fileFlows.getStatus();

    return res.status(200).json({
      processing: status.processing ?? 0,
      queue: status.queue ?? 0,
    });
  } catch (e) {
    logger.error('Failed to test FileFlows connection', {
      label: 'FileFlows',
      message: e instanceof Error ? e.message : String(e),
    });
    return res.status(500).json({ message: 'Failed to connect to FileFlows.' });
  }
});

// Diagnostic view: what FileFlows is processing, the downloads seerr sees, and
// how they map to media (so you can spot name/queue mismatches that prevent the
// "Processing in FileFlows" badge from showing).
fileflowsRoutes.get('/mappings', async (_req, res) => {
  const settings = getSettings().fileflows;

  if (!settings.enabled || !settings.hostname) {
    return res.status(200).json({
      enabled: false,
      processing: 0,
      queue: 0,
      files: [],
      mappings: [],
    });
  }

  try {
    const fileFlows = new FileFlowsAPI(settings);
    const status = await fileFlows.getStatus();

    const files = (status.processingFiles ?? []).map((file) => {
      const normalized = (file.name || file.relativePath || '').replace(
        /\\/g,
        '/'
      );
      return normalized.split('/').filter(Boolean).pop() ?? normalized;
    });

    const mediaRepository = getRepository(Media);
    const downloads = downloadTracker.getAllDownloads();

    const mappings = await Promise.all(
      downloads.map(async (download) => {
        const matched = await fileFlowsTracker.isReleaseProcessing(
          download.title
        );

        const media = await mediaRepository.findOne({
          where: [
            {
              mediaType: download.mediaType,
              externalServiceId: download.externalId,
            },
            {
              mediaType: download.mediaType,
              externalServiceId4k: download.externalId,
            },
          ],
        });

        return {
          title: download.title,
          mediaType: download.mediaType === MediaType.MOVIE ? 'movie' : 'tv',
          tmdbId: media?.tmdbId ?? null,
          fileFlowsProcessing: matched,
          badgeActive: media?.fileFlowsProcessing ?? false,
        };
      })
    );

    return res.status(200).json({
      enabled: true,
      processing: status.processing ?? 0,
      queue: status.queue ?? 0,
      files,
      mappings,
    });
  } catch (e) {
    logger.error('Failed to load FileFlows mappings', {
      label: 'FileFlows',
      message: e instanceof Error ? e.message : String(e),
    });
    return res
      .status(500)
      .json({ message: 'Failed to load FileFlows mappings.' });
  }
});

export default fileflowsRoutes;
