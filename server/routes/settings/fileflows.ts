import FileFlowsAPI from '@server/api/fileflows';
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

export default fileflowsRoutes;
