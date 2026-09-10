import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseResume, parseJd } from '../lib/parse.js';
import { matchPair } from '../lib/pipeline.js';
import { keywordBaseline } from '../lib/score.js';
import { newStats } from '../lib/model.js';

export const router = express.Router();

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(here, '..', 'data');
const labels = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'labels.json'), 'utf8'));
const readSample = (file) => fs.readFileSync(path.join(DATA_DIR, file), 'utf8');

/**
 * GET /api/eval — scores the 15 labelled pairs and reports our numbers next to
 * a pure keyword-overlap baseline on the SAME pairs. The baseline is the
 * honest comparison, because keyword overlap is what an ATS actually does.
 *
 * ?offline=1 forces rules-only semantic matching (no model calls at all).
 */
router.get('/', async (req, res) => {
  const stats = newStats();
  const startedAt = Date.now();
  const offline = req.query.offline === '1';

  try {
    const resumes = {};
    for (const entry of labels.resumes) {
      const text = readSample(entry.file);
      const parsed = await parseResume(text, stats);
      resumes[entry.id] = { ...parsed, text, label: entry.label };
    }
    const jds = {};
    for (const entry of labels.jds) {
      const text = readSample(entry.file);
      const parsed = await parseJd(text, stats);
      jds[entry.id] = { ...parsed, text, label: entry.label };
    }

    const rows = [];
    for (const pair of labels.pairs) {
      const resume = resumes[pair.resume_id];
      const jd = jds[pair.jd_id];
      const result = await matchPair(
        { id: resume.id, parsed: resume.parsed, text: resume.text },
        { id: jd.id, parsed: jd.parsed, text: jd.text },
        { withAdvice: false, offlineSemantics: offline, stats },
      );
      const baseline = keywordBaseline(resume.parsed, jd.parsed, resume.text);
      rows.push({
        resume_id: pair.resume_id,
        resume_label: resume.label,
        jd_id: pair.jd_id,
        jd_label: jd.label,
        expected: pair.label,
        got: result.verdict,
        correct: result.verdict === pair.label,
        score: result.overall_score,
        sub_scores: result.sub_scores,
        baseline_score: baseline.overall_score,
        baseline_verdict: baseline.verdict,
        baseline_correct: baseline.verdict === pair.label,
        semantic_credits: result.matched.filter((m) => m.match_type !== 'exact').length,
      });
    }

    const parseRecords = [...Object.values(resumes), ...Object.values(jds)];
    // Validity = the parse produced a schema-valid object without falling back.
    // Confidence is reported separately; a low-confidence parse is still valid.
    const valid = parseRecords.filter((r) => !r.parsed._fallback);

    res.json({
      n: rows.length,
      ours: {
        verdict_accuracy: ratio(rows.filter((r) => r.correct).length, rows.length),
        ranking_agreement: rankingAgreement(rows, labels.rankings, 'score'),
      },
      keyword_baseline: {
        verdict_accuracy: ratio(rows.filter((r) => r.baseline_correct).length, rows.length),
        ranking_agreement: rankingAgreement(rows, labels.rankings, 'baseline_score'),
      },
      random_baseline: { verdict_accuracy: ratio(1, 3) },
      majority_class_baseline: { verdict_accuracy: majorityBaseline(rows) },
      parse_validity_rate: ratio(valid.length, parseRecords.length),
      semantic_credits_awarded: rows.reduce((sum, r) => sum + r.semantic_credits, 0),
      mode: offline ? 'rules-only (no model calls)' : 'full',
      rows,
      stats: { ...stats, elapsed_ms: Date.now() - startedAt },
      caveat: `n=${rows.length} is small. Treat these as indicative, not significant — the confidence interval on 15 pairs is wide.`,
    });
  } catch (error) {
    console.error('[eval]', error);
    res.status(500).json({ error: 'Eval failed.', code: 'internal' });
  }
});

const ratio = (hits, total) => (total ? Math.round((1000 * hits) / total) / 10 : 0);

/**
 * Pairwise ranking agreement: over every pair of JDs a resume was ranked
 * against, does our ordering agree with the hand ordering? Ties count as
 * disagreement — a tool that ranks nothing has not answered the question.
 */
function rankingAgreement(rows, rankings, scoreField) {
  let agree = 0;
  let total = 0;
  for (const ranking of rankings) {
    const scoreOf = (jdId) => rows.find((r) => r.resume_id === ranking.resume_id && r.jd_id === jdId)?.[scoreField];
    for (let i = 0; i < ranking.order.length; i += 1) {
      for (let j = i + 1; j < ranking.order.length; j += 1) {
        const better = scoreOf(ranking.order[i]);
        const worse = scoreOf(ranking.order[j]);
        if (better === undefined || worse === undefined) continue;
        total += 1;
        if (better > worse) agree += 1;
      }
    }
  }
  return ratio(agree, total);
}

/** Always guessing the commonest label. The bar a 3-class number must clear. */
function majorityBaseline(rows) {
  const counts = {};
  for (const row of rows) counts[row.expected] = (counts[row.expected] || 0) + 1;
  return ratio(Math.max(...Object.values(counts)), rows.length);
}
