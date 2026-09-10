// One (resume, JD) pair, end to end. Both /api/match and /api/matrix call
// this, so a cell in the matrix and a single score are computed by literally
// the same code path — no second implementation to drift.
import { runAtsChecks } from './atsRules.js';
import { scoreMatch, keywordBaseline } from './score.js';
import { validateMatchResult } from './schema.js';
import { resolveSemantics, resolveSemanticsOffline } from './semantic.js';
import { suggestCourses, suggestImprovements } from './advice.js';
import { USE_STUB } from './model.js';

/**
 * @param {object} resume  { id, parsed, text }
 * @param {object} jd      { id, parsed, text }
 * @param {object} options { withAdvice, offlineSemantics, stats }
 */
export async function matchPair(resume, jd, { withAdvice = true, offlineSemantics = false, stats } = {}) {
  const atsReport = runAtsChecks(resume.text || '');

  const semantics = (offlineSemantics || USE_STUB)
    ? resolveSemanticsOffline(resume.parsed, jd.parsed, stats)
    : await resolveSemantics(resume.parsed, jd.parsed, stats);

  const result = validateMatchResult(
    scoreMatch(resume.parsed, jd.parsed, semantics.verdicts, atsReport, {
      resume_id: resume.id,
      jd_id: jd.id,
    }),
  );

  if (withAdvice) {
    const blocking = result.gaps.filter((g) => g.severity !== 'minor');
    const [courses, improvements] = await Promise.all([
      suggestCourses(blocking, stats),
      suggestImprovements(resume.parsed, jd.parsed, blocking, stats),
    ]);
    result.suggested_courses = courses;
    result.resume_improvements = improvements;
  }

  // Everything a judge might ask about how this number was produced.
  result._meta = {
    role_title: jd.parsed.role_title,
    candidate_name: resume.parsed.name,
    resolved_by_rule: semantics.resolved_by_rule,
    resolved_by_model: semantics.resolved_by_model,
    semantic_model_called: semantics.model_called,
    parse_confidence: {
      resume: resume.parsed._parse_confidence,
      jd: jd.parsed._parse_confidence,
    },
    parsed_by: { resume: resume.parsed._parsed_by, jd: jd.parsed._parsed_by },
    degraded: Boolean(semantics._fallback || resume.parsed._fallback || jd.parsed._fallback),
    ats_checks_total: atsReport.length,
    ats_checks_failed: atsReport.filter((c) => !c.passed).length,
    keyword_baseline: keywordBaseline(resume.parsed, jd.parsed, resume.text || ''),
  };

  result.ats_report = atsReport;
  return result;
}
