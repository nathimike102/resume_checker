import express from 'express';
import { parseResume, parseJd } from '../lib/parse.js';
import { extractFromText, ExtractionError } from '../lib/extract.js';
import { matchPair } from '../lib/pipeline.js';
import { newStats } from '../lib/model.js';

export const router = express.Router();
export const MAX_SIDE = 5; // hard cap, stated in the UI

/**
 * POST /api/matrix { resumes: [{label,text}], jds: [{label,text}] }
 *
 * The differentiator. M+N parses, then M*N deterministic matches over the
 * structured objects. The stats block is not decoration — it is the evidence
 * for the claim that 3 resumes x 4 JDs costs 7 model calls and not 12.
 */
router.post('/', async (req, res) => {
  const stats = newStats();
  const startedAt = Date.now();
  try {
    const resumeInputs = normalise(req.body?.resumes, 'Resume');
    const jdInputs = normalise(req.body?.jds, 'Role');

    if (!resumeInputs.length || !jdInputs.length) {
      return res.status(400).json({ error: 'Send at least one resume and one job description.' });
    }
    if (resumeInputs.length > MAX_SIDE || jdInputs.length > MAX_SIDE) {
      return res.status(400).json({
        error: `Capped at ${MAX_SIDE} x ${MAX_SIDE}. You sent ${resumeInputs.length} x ${jdInputs.length}.`,
        code: 'cap_exceeded',
      });
    }

    // ---- Phase 1: parse each document ONCE. M + N calls. -------------------
    const resumes = await Promise.all(resumeInputs.map(async (input) => {
      const text = extractFromText(input.text).text;
      const parsed = await parseResume(text, stats);
      return { ...parsed, label: input.label, text };
    }));
    const jds = await Promise.all(jdInputs.map(async (input) => {
      const text = extractFromText(input.text).text;
      const parsed = await parseJd(text, stats);
      return { ...parsed, label: input.label || parsed.parsed.role_title, text };
    }));
    const parseCalls = stats.model_calls;

    // ---- Phase 2: M x N matches over the structured objects ----------------
    // Advice is off here: the matrix answers "which resume for which job",
    // and the user drills into a single cell for courses and rewrites.
    const cells = [];
    for (const resume of resumes) {
      const row = [];
      for (const jd of jds) {
        row.push(await matchPair(
          { id: resume.id, parsed: resume.parsed, text: resume.text },
          { id: jd.id, parsed: jd.parsed, text: jd.text },
          { withAdvice: false, stats },
        ));
      }
      cells.push(row);
    }

    const matrix = cells.map((row) => row.map((cell) => cell.overall_score));
    const bestPerJd = jds.map((jd, j) => {
      const scores = matrix.map((row) => row[j]);
      const winner = scores.indexOf(Math.max(...scores));
      return { jd_label: jd.label, jd_id: jd.id, resume_label: resumes[winner].label, resume_index: winner, score: scores[winner] };
    });
    const bestPerResume = resumes.map((resume, i) => {
      const scores = matrix[i];
      const winner = scores.indexOf(Math.max(...scores));
      return { resume_label: resume.label, resume_id: resume.id, jd_label: jds[winner].label, jd_index: winner, score: scores[winner] };
    });

    res.json({
      resumes: resumes.map((r) => ({ id: r.id, label: r.label, name: r.parsed.name, cached: r.cached })),
      jds: jds.map((j) => ({ id: j.id, label: j.label, role_title: j.parsed.role_title, cached: j.cached })),
      matrix,
      cells: cells.map((row) => row.map(summarise)),
      best_per_jd: bestPerJd,
      best_per_resume: bestPerResume,
      summary: summaryLine(resumes, jds, bestPerJd),
      stats: {
        ...stats,
        pairs_scored: resumes.length * jds.length,
        parse_calls: parseCalls,
        naive_calls_would_be: resumes.length * jds.length,
        elapsed_ms: Date.now() - startedAt,
      },
    });
  } catch (error) {
    if (error instanceof ExtractionError) {
      return res.status(400).json({ error: error.message, code: error.code });
    }
    console.error('[matrix]', error);
    res.status(500).json({ error: 'Matrix failed.', code: 'internal' });
  }
});

const summarise = (cell) => ({
  overall_score: cell.overall_score,
  verdict: cell.verdict,
  sub_scores: cell.sub_scores,
  top_gaps: cell.gaps.filter((g) => g.severity === 'blocking').slice(0, 3).map((g) => g.requirement),
  matched_count: cell.matched.length,
});

function summaryLine(resumes, jds, bestPerJd) {
  const wins = new Map();
  for (const best of bestPerJd) wins.set(best.resume_label, (wins.get(best.resume_label) || 0) + 1);
  const ranked = [...wins.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return '';
  const [topLabel, topWins] = ranked[0];
  const rest = ranked.slice(1)
    .map(([label, count]) => `${label} wins ${count === 1 ? 'only ' : ''}${count} of ${jds.length}`)
    .join('; ');
  const head = `${topLabel} wins ${topWins} of ${jds.length} roles`;
  return rest ? `${head}; ${rest}.` : `${head}.`;
}

function normalise(list, prefix) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item, index) => (typeof item === 'string'
      ? { label: `${prefix} ${String.fromCharCode(65 + index)}`, text: item }
      : { label: item?.label || `${prefix} ${String.fromCharCode(65 + index)}`, text: item?.text || '' }))
    .filter((item) => item.text.trim().length > 0);
}
