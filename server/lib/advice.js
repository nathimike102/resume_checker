// Courses and resume rewrites. Two constrained model calls, both of which
// degrade to something useful when the model is unavailable.
import { askJson } from './model.js';
import { COURSES_SCHEMA, IMPROVEMENTS_SCHEMA } from './jsonSchemas.js';
import { catalogueForPrompt, materialisePicks, selectCoursesForGap } from './courses.js';
import { USE_STUB } from './model.js';
import { CREDIT } from './score.js';

const COURSE_SYSTEM = 'You select training from a fixed catalogue. You may only return course ids that appear in the catalogue given to you.';

/**
 * The model picks ids FROM THE FILE and writes a rationale. Any id not in the
 * catalogue is dropped by materialisePicks() — so a hallucinated course cannot
 * reach the user even if the model invents one.
 */
export async function suggestCourses(gaps, stats) {
  const targets = chooseTargets(gaps);
  if (!targets.length) return [];

  if (USE_STUB) return dedupe(targets.flatMap((gap) => selectCoursesForGap(gap.requirement, 2)));

  const raw = await askJson(
    `Pick courses that close these gaps for a final-year student.

RULES
- Return at most 2 course_ids per gap, and only ids from the catalogue below.
- "gap" must repeat the gap name EXACTLY as written below. Do not add anything to it.
- If nothing in the catalogue genuinely closes a gap, return nothing for that gap. Do not stretch.
- Prefer the shortest course that actually covers the gap.
- "rationale" is one line, under 20 words, naming what the course covers that the gap needs.
- Never write a course title or provider — only the id and your rationale.

GAPS
${targets.map((g) => `- ${g.requirement}`).join('\n')}

CATALOGUE
${catalogueForPrompt(targets.map((g) => g.requirement))}`,
    { system: COURSE_SYSTEM, schema: COURSES_SCHEMA, maxTokens: 900, stats },
  );

  if (raw?._error) {
    // Deterministic skill-overlap picks instead. Still catalogue-only.
    return dedupe(targets.flatMap((gap) => selectCoursesForGap(gap.requirement, 1)));
  }

  // The model is asked to echo the gap name, but it embellishes ("bash
  // (blocking)"). Snap every pick back onto a real gap so the de-duplication
  // below actually matches, and drop anything that fits no gap at all.
  const picks = materialisePicks(raw.picks)
    .map((pick) => ({ ...pick, closes_gap: snapToGap(pick.closes_gap, targets) }))
    .filter((pick) => pick.closes_gap);

  const covered = new Set(picks.map((p) => p.closes_gap));
  for (const gap of targets.filter((g) => !covered.has(g.requirement))) {
    picks.push(...selectCoursesForGap(gap.requirement, 1));
  }
  return dedupe(picks);
}

/**
 * What is worth learning — decided by the credit tier, not by severity.
 *
 *   0.0 absent   -> learn it, it is not there at all
 *   0.5 adjacent -> learn it: Docker is not Kubernetes, and the JD asked for
 *                   Kubernetes
 *   0.7 claimed  -> do NOT: they already have it, it is just not evidenced.
 *                   That is a rewrite problem, and the rewrite section says so.
 *   0.8 semantic -> do NOT: they have demonstrably done this work
 *
 * An earlier version fell back to "the weakest required skills" whenever
 * nothing was absent, so a strong match recommended a Machine Learning
 * Specialization to someone already using PyTorch and transformers. Silence is
 * better than bad advice — and the report now says why it is silent rather
 * than just showing nothing.
 */
function chooseTargets(gaps) {
  const rank = { blocking: 0, important: 1, minor: 2 };
  return gaps
    .filter((g) => g.credit === 0 || g.credit === CREDIT.adjacent)
    .sort((a, b) => rank[a.severity] - rank[b.severity] || a.credit - b.credit)
    .slice(0, 8);
}

/** "bash (blocking)" -> "bash". Returns '' when it matches no known gap. */
function snapToGap(label, targets) {
  const clean = String(label || '').toLowerCase().trim();
  const exact = targets.find((g) => g.requirement.toLowerCase() === clean);
  if (exact) return exact.requirement;
  const partial = targets.find((g) => clean.startsWith(g.requirement.toLowerCase())
    || clean.includes(g.requirement.toLowerCase()));
  return partial ? partial.requirement : '';
}

/**
 * One card per course, listing every gap it closes.
 *
 * A JD that asks for AWS usually also asks for EC2, S3, IAM and VPC, and one
 * AWS course closes all five. Showing that course five times is noise;
 * dropping four of them looked like the suggestions were broken. Merge
 * instead, so the card says what it actually covers.
 */
function dedupe(picks) {
  const byCourse = new Map();
  for (const pick of picks) {
    const existing = byCourse.get(pick.course_id);
    if (!existing) {
      byCourse.set(pick.course_id, { ...pick, gaps: [pick.closes_gap] });
    } else if (!existing.gaps.includes(pick.closes_gap)) {
      existing.gaps.push(pick.closes_gap);
    }
  }
  return [...byCourse.values()].map((pick) => ({
    ...pick,
    closes_gap: pick.gaps.join(', '),
  })).slice(0, 4);
}

const REWRITE_SYSTEM = 'You rewrite resume bullets. You never add achievements, numbers, technologies or claims that are not already in the original bullet.';

export async function suggestImprovements(profile, jd, gaps, stats) {
  const bullets = [
    ...(profile.experience || []).flatMap((e) => (e.highlights || []).map((h) => ({ target: `${e.title || 'Experience'} bullet`, text: h }))),
    ...(profile.projects || []).map((p) => ({ target: `Project: ${p.name}`, text: p.one_line })),
  ].filter((b) => b.text).slice(0, 12);

  if (!bullets.length) return [];
  if (USE_STUB) return offlineImprovements(bullets, jd, gaps);

  const raw = await askJson(
    `Rewrite the three weakest bullets on this resume for this specific job.

HARD CONSTRAINT
The rewrite must stay truthful to what the bullet already claims. Do not invent
metrics, scale, technologies, team sizes or outcomes. If a bullet has no number,
the rewrite has no number. You may only reframe what is already there in the
language this JD uses.

For each of the three, return:
- target: which bullet (copy the label given)
- issue: what is weak about it for THIS job, in one clause
- suggested_rewrite: the rewritten bullet

ROLE: ${jd.role_title} (${jd.seniority})
WHAT THIS JD WANTS: ${(jd.must_have || []).map((r) => r.skill).join(', ')}
KNOWN GAPS: ${gaps.map((g) => g.requirement).join(', ') || '(none)'}

BULLETS
${bullets.map((b) => `[${b.target}] ${b.text}`).join('\n')}`,
    { system: REWRITE_SYSTEM, schema: IMPROVEMENTS_SCHEMA, maxTokens: 1400, stats },
  );

  if (raw?._error) return offlineImprovements(bullets, jd, gaps);
  return (raw.improvements || []).slice(0, 3).map((item) => ({
    target: String(item.target || '').slice(0, 120),
    issue: String(item.issue || '').slice(0, 240),
    suggested_rewrite: String(item.suggested_rewrite || '').slice(0, 400),
  }));
}

/**
 * Offline improvements are rule-based and deliberately modest: we point at the
 * weakness, we do not write a fake rewrite. Better to say less than to invent.
 */
function offlineImprovements(bullets, jd, gaps) {
  const wanted = (jd.must_have || []).map((r) => r.skill);
  const out = [];

  const noNumbers = bullets.filter((b) => !/\d/.test(b.text)).slice(0, 2);
  for (const bullet of noNumbers) {
    out.push({
      target: bullet.target,
      issue: 'No scale or outcome — a reader cannot tell how much of this you did.',
      suggested_rewrite: `${bullet.text.replace(/\.$/, '')} — add the number: how many users, records, or how much faster.`,
      _generated_by: 'rule',
    });
  }

  const unmentioned = wanted.filter((skill) => !bullets.some((b) => b.text.toLowerCase().includes(skill)));
  if (unmentioned.length && bullets[0]) {
    out.push({
      target: bullets[0].target,
      issue: `This JD leads on ${unmentioned.slice(0, 3).join(', ')} and your strongest bullet never uses those words.`,
      suggested_rewrite: `Reframe using the JD's vocabulary where it is genuinely true of the work: ${unmentioned.slice(0, 3).join(', ')}.`,
      _generated_by: 'rule',
    });
  }

  if (!out.length && gaps.length) {
    out.push({
      target: 'Skills section',
      issue: `Blocking gaps (${gaps.slice(0, 2).map((g) => g.requirement).join(', ')}) are not evidenced anywhere.`,
      suggested_rewrite: 'Add a project bullet that demonstrates these, or drop them from consideration for this role.',
      _generated_by: 'rule',
    });
  }
  return out.slice(0, 3);
}
