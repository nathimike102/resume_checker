import express from 'express';
import { buildPdf, buildDocx, fileBase } from '../lib/export.js';

export const router = express.Router();

const BUILDERS = {
  pdf: { build: buildPdf, type: 'application/pdf' },
  docx: { build: buildDocx, type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
};

/**
 * POST /api/export/:format  { result }
 *
 * Takes a MatchResult the client already holds and returns the file. Nothing
 * is re-scored and no model is called, so downloading is free and the file
 * always says exactly what the user was shown.
 */
router.post('/:format', async (req, res) => {
  const builder = BUILDERS[String(req.params.format).toLowerCase()];
  if (!builder) return res.status(400).json({ error: 'Format must be pdf or docx.' });

  const result = req.body?.result;
  if (!result || typeof result.overall_score !== 'number') {
    return res.status(400).json({ error: 'Send the result object you want exported.' });
  }

  try {
    const file = await builder.build(result);
    if (!file) {
      return res.status(503).json({ error: 'That export format is unavailable on this server.' });
    }
    res.setHeader('Content-Type', builder.type);
    res.setHeader('Content-Disposition',
      `attachment; filename="${fileBase(result)}.${req.params.format}"`);
    res.send(file);
  } catch (error) {
    console.error('[export]', error);
    res.status(500).json({ error: 'Could not build that file.' });
  }
});
