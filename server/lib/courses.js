// The catalogue is grounding data. The model SELECTS ids from it and writes a
// rationale; anything it returns that isn't in this file is dropped on the
// floor. That is why we can say it cannot hallucinate a course.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normSkill } from './schema.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CATALOGUE_PATH = path.join(here, '..', 'data', 'courses.json');

const catalogue = JSON.parse(fs.readFileSync(CATALOGUE_PATH, 'utf8'));
export const COURSES = catalogue.courses;
const byId = new Map(COURSES.map((course) => [course.id, course]));

export const getCourse = (id) => byId.get(String(id).trim()) || null;

const courseLine = (c) => `${c.id} | ${c.title} | ${c.provider} | skills: ${c.skills.join(', ')} | ${c.level} | ${c.hours}h`;

/**
 * Compact list for the prompt — ids and skills only, no prose to copy.
 *
 * Sending all 42 courses cost ~2.5k tokens on every call, which on a
 * rate-limited tier is the difference between a course list and a 429. When
 * gaps are known we shortlist by skill overlap and send a fraction of that;
 * the model still only ever sees real ids, so it still cannot invent one.
 */
export function catalogueForPrompt(gapSkills = []) {
  if (!gapSkills.length) return COURSES.map(courseLine).join('\n');

  const shortlist = new Map();
  for (const gap of gapSkills) {
    for (const pick of selectCoursesForGap(gap, 3)) {
      const course = getCourse(pick.course_id);
      if (course) shortlist.set(course.id, course);
    }
  }
  // Nothing matched by rules? Fall back to the whole catalogue rather than
  // handing the model an empty list and guaranteeing no suggestions.
  if (!shortlist.size) return COURSES.map(courseLine).join('\n');
  return [...shortlist.values()].map(courseLine).join('\n');
}

/**
 * Deterministic fallback used in stub mode and whenever the model call fails:
 * pick by literal skill overlap with the gap. Boring, explainable, offline.
 */
export function selectCoursesForGap(gapSkill, limit = 2) {
  const want = normSkill(gapSkill);
  const wantTokens = tokensOf(want);

  const scored = COURSES.map((course) => {
    let score = 0;
    for (const raw of course.skills) {
      const skill = normSkill(raw);
      const skillTokens = tokensOf(skill);
      if (skill === want) score += 10;
      else if (contains(wantTokens, skillTokens) || contains(skillTokens, wantTokens)) score += 6;
      else score += 3 * skillTokens.filter((t) => t.length > 3 && wantTokens.includes(t)).length;
    }
    return { course, score };
  })
    // A single shared word ("systems" in "type systems") is not a reason to
    // recommend a course. Below the bar we return nothing, which is the
    // correct answer when the catalogue genuinely does not cover a gap.
    .filter((row) => row.score >= 6)
    .sort((a, b) => b.score - a.score || a.course.hours - b.course.hours);

  return scored.slice(0, limit).map(({ course }) => ({
    course_id: course.id,
    title: course.title,
    provider: course.provider,
    closes_gap: gapSkill,
    rationale: `Covers ${course.skills.slice(0, 3).join(', ')} in about ${course.hours} hours.`,
    _selected_by: 'rule',
  }));
}

const tokensOf = (text) => text.split(/[ ./-]+/).filter(Boolean);

/** True when b's tokens appear consecutively inside a's tokens. */
function contains(a, b) {
  if (!b.length || b.length > a.length) return false;
  return a.some((_, i) => b.every((token, j) => a[i + j] === token));
}

/** Turns whatever the model picked into catalogue-backed records, or nothing. */
export function materialisePicks(picks = []) {
  const out = [];
  const seen = new Set();
  for (const pick of picks) {
    const course = getCourse(pick?.course_id);
    if (!course) continue; // not in the file -> it does not exist
    const key = `${pick.gap}::${course.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      course_id: course.id,
      title: course.title,
      provider: course.provider,
      closes_gap: String(pick.gap || ''),
      rationale: String(pick.rationale || '').slice(0, 240),
      _selected_by: 'model',
    });
  }
  return out;
}

/** Every skill string the catalogue knows about — also our stub vocabulary. */
export const CATALOGUE_SKILLS = [...new Set(COURSES.flatMap((c) => c.skills.map(normSkill)))];
