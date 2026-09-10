import express from 'express';
import { parseResume, parseJd } from '../lib/parse.js';
import { extractFromBuffer, extractFromText, ExtractionError } from '../lib/extract.js';
import { runAtsChecks } from '../lib/atsRules.js';
import { newStats } from '../lib/model.js';

export const router = express.Router();

/** Accepts { text } or a base64 { file, filename }. Both end up as a string. */
async function getText(body) {
  if (body?.file) {
    const buffer = Buffer.from(body.file, 'base64');
    return extractFromBuffer(buffer, body.filename || '');
  }
  return extractFromText(body?.text || '');
}

router.post('/resume', async (req, res) => {
  const stats = newStats();
  try {
    const { text, source, pages } = await getText(req.body);
    const { id, hash, parsed, cached } = await parseResume(text, stats);
    res.json({
      resume_id: id,
      hash,
      cached,
      source,
      pages,
      parsed,
      ats_report: runAtsChecks(text),
      stats,
    });
  } catch (error) {
    if (error instanceof ExtractionError) {
      return res.status(400).json({ error: error.message, code: error.code });
    }
    console.error('[parse/resume]', error);
    res.status(500).json({ error: 'Could not parse that resume.', code: 'internal' });
  }
});

router.post('/jd', async (req, res) => {
  const stats = newStats();
  try {
    const { text, source } = await getText(req.body);
    const { id, hash, parsed, cached } = await parseJd(text, stats);
    res.json({ jd_id: id, hash, cached, source, parsed, stats });
  } catch (error) {
    if (error instanceof ExtractionError) {
      return res.status(400).json({ error: error.message, code: error.code });
    }
    console.error('[parse/jd]', error);
    res.status(500).json({ error: 'Could not parse that job description.', code: 'internal' });
  }
});
