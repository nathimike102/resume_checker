// Parse once, compare many. ONE model call per resume and per JD, cached by
// sha256 of the text — so M resumes against N JDs costs M+N calls, not M*N,
// and re-running a cached resume against a fifth JD costs nothing.
import { askJson, USE_STUB } from './model.js';
import { RESUME_SCHEMA, JD_SCHEMA } from './jsonSchemas.js';
import { validateResume, validateJd } from './schema.js';
import { cachedParse } from './cache.js';
import { heuristicParseResume, heuristicParseJd } from './heuristicParse.js';

const SYSTEM = 'You extract structured data from hiring documents. You return data that is present in the document. You never invent skills, employers, dates or achievements that are not written there.';

export const RESUME_PROMPT = (text) => `Extract this resume into the exact schema.

RULES
- Only record skills the resume actually claims. Do not infer a skill from a related one.
- "evidence" must be a verbatim phrase or sentence copied from the resume showing that skill in use. If the skill only appears in a skills list with no supporting sentence, set evidence to "" and strength to "mentioned".
- "strength" is "strong" when the skill appears in a bullet describing work done, "mentioned" when it only appears in a list.
- duration_months is the length of each role in months. If a role says "Present", count to today.
- total_experience_months counts professional work and internships only. Coursework and personal projects do not count.
- Leave any field you cannot find as "" or 0. An empty field is correct; a guessed one is not.
- _parse_confidence: "high" if the document was clean and well-sectioned, "medium" if you had to infer structure, "low" if the text was fragmentary.

RESUME
"""
${text.slice(0, 24000)}
"""`;

export const JD_PROMPT = (text) => `Extract this job description into the exact schema.

RULES
- must_have: requirements the JD states as required, essential, or "must have". nice_to_have: anything it calls preferred, bonus, a plus, or desirable.
- If the JD does not separate the two, judge it: things named in the core stack are must_have, things named once in passing are nice_to_have.
- "skill" must be a short canonical name ("kubernetes", "react", "ci/cd"), not a sentence. Split compound requirements into separate entries.
- "why" is one short clause on why the role needs it, drawn from the JD.
- "weight" is 1-5 for how central the requirement is to this role. Most must-haves are 3. Reserve 5 for something the role is built around.
- min_experience_months: convert stated years to months. If the JD asks for no experience or does not say, use 0.
- Do not add requirements the JD does not state.

JOB DESCRIPTION
"""
${text.slice(0, 24000)}
"""`;

async function parseResumeUncached(text, stats) {
  if (USE_STUB) return { ...validateResume(heuristicParseResume(text)), _parsed_by: 'heuristic' };
  const raw = await askJson(RESUME_PROMPT(text), { system: SYSTEM, schema: RESUME_SCHEMA, stats });
  // Model unreachable or off-schema? Fall back to the offline parser rather
  // than handing the user a blank screen.
  if (raw?._error) {
    const fallback = validateResume(heuristicParseResume(text));
    return { ...fallback, _fallback: true, _error: raw._error, _parsed_by: 'heuristic-fallback' };
  }
  return { ...validateResume(raw), _parsed_by: 'model' };
}

async function parseJdUncached(text, stats) {
  if (USE_STUB) return { ...validateJd(heuristicParseJd(text)), _parsed_by: 'heuristic' };
  const raw = await askJson(JD_PROMPT(text), { system: SYSTEM, schema: JD_SCHEMA, stats });
  if (raw?._error) {
    const fallback = validateJd(heuristicParseJd(text));
    return { ...fallback, _fallback: true, _error: raw._error, _parsed_by: 'heuristic-fallback' };
  }
  return { ...validateJd(raw), _parsed_by: 'model' };
}

export const parseResume = (text, stats) =>
  cachedParse('resume', text, () => parseResumeUncached(text, stats), stats);

export const parseJd = (text, stats) =>
  cachedParse('jd', text, () => parseJdUncached(text, stats), stats);
