import express from 'express';
import { parseResume, parseJd } from '../lib/parse.js';
import { extractFromText, ExtractionError } from '../lib/extract.js';
import { matchPair } from '../lib/pipeline.js';
import { newStats } from '../lib/model.js';

export const router = express.Router();

/** POST /api/match { resume_text, jd_text } -> MatchResult */
router.post('/', async (req, res) => {
  const stats = newStats();
  const startedAt = Date.now();
  try {
    const resumeText = extractFromText(req.body?.resume_text || '').text;
    const jdText = extractFromText(req.body?.jd_text || '').text;

    const [resume, jd] = await Promise.all([
      parseResume(resumeText, stats),
      parseJd(jdText, stats),
    ]);

    const result = await matchPair(
      { id: resume.id, parsed: resume.parsed, text: resumeText },
      { id: jd.id, parsed: jd.parsed, text: jdText },
      { stats },
    );

    res.json({ ...result, stats: { ...stats, elapsed_ms: Date.now() - startedAt } });
  } catch (error) {
    if (error instanceof ExtractionError) {
      return res.status(400).json({ error: error.message, code: error.code });
    }
    console.error('[match]', error);
    res.status(500).json({ error: 'Scoring failed.', code: 'internal' });
  }
});
