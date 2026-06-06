import FileFlowsAPI from '@server/api/fileflows';
import fileFlowsTracker from '@server/lib/fileflows';
import { Permission } from '@server/lib/permissions';
import { getSettings, type FileFlowsSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { Router } from 'express';

const fileflowsRoutes = Router();

// FileFlows proxies an unauthenticated upstream API (hostname, token, file
// paths). Restrict every route here to admins even though the parent
// /settings router already enforces ADMIN — keeps this surface safe if the
// mount point ever changes.
fileflowsRoutes.use(isAuthenticated(Permission.ADMIN));

fileflowsRoutes.get('/', (_req, res) => {
  const settings = getSettings();
  res.status(200).json(settings.fileflows);
});

fileflowsRoutes.post('/', async (req, res) => {
  const settings = getSettings();
  const body = req.body as Partial<FileFlowsSettings>;

  // Whitelist known fields to avoid arbitrary settings injection.
  const availabilitySync =
    body.availabilitySync === 'active'
      ? 'active'
      : body.availabilitySync === 'schedule'
        ? 'schedule'
        : settings.fileflows.availabilitySync;

  settings.fileflows = {
    enabled: body.enabled ?? settings.fileflows.enabled,
    hostname: body.hostname ?? settings.fileflows.hostname,
    port: body.port ?? settings.fileflows.port,
    useSsl: body.useSsl ?? settings.fileflows.useSsl,
    apiKey: body.apiKey ?? settings.fileflows.apiKey,
    urlBase: body.urlBase ?? settings.fileflows.urlBase,
    availabilitySync,
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

// Diagnostic view: each file FileFlows is processing, resolved (via Radarr/
// Sonarr's release parser) to the media it maps to, plus whether the
// "processing in FileFlows" badge is active for it.
fileflowsRoutes.get('/mappings', async (_req, res) => {
  const settings = getSettings().fileflows;

  if (!settings.enabled || !settings.hostname) {
    return res
      .status(200)
      .json({ enabled: false, processing: 0, queue: 0, files: [] });
  }

  try {
    const { processing, queue, files } =
      await fileFlowsTracker.getFileMappings();

    return res.status(200).json({ enabled: true, processing, queue, files });
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
