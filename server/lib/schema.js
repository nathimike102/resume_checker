// Never trust model output. Everything from the model goes through here and
// comes out schema-shaped: unknown enums fall back, numbers clamp, missing
// fields get safe defaults. A record flagged _fallback:true still renders.

import { canonicalise } from './equivalences.js';

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(+n) ? +n : lo));
const str = (v, fallback = '') => (typeof v === 'string' ? v.trim() : fallback);
const arr = (v) => (Array.isArray(v) ? v : []);
const oneOf = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);

const CONFIDENCE = ['high', 'medium', 'low'];
const SENIORITY = ['intern', 'junior', 'mid', 'senior'];
const STRENGTH = ['strong', 'mentioned'];
const SEVERITY = ['blocking', 'important', 'minor'];
const MATCH_TYPE = ['exact', 'semantic', 'adjacent'];

// Skill names are compared as sets all over the scorer, so normalise once here
// and never again. Lowercase, collapse whitespace, drop punctuation.
export function normSkill(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[(（].*?[)）]/g, ' ')
    // Hyphens become spaces so "event-driven" and "event driven" are one term.
    .replace(/[-–—]/g, ' ')
    .replace(/[^a-z0-9+#./ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupeBy(items, keyOf) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function validateResume(raw) {
  const bad = Boolean(!raw || typeof raw !== 'object' || raw._error);
  const input = bad ? {} : raw;
  const skills = arr(input.skills)
    .map((s) => ({
      name: canonicalise(normSkill(typeof s === 'string' ? s : s?.name)),
      evidence: str(s?.evidence),
      strength: oneOf(s?.strength, STRENGTH, 'mentioned'),
    }))
    .filter((s) => s.name.length > 0);

  const experience = arr(input.experience).map((e) => ({
    title: str(e?.title),
    org: str(e?.org),
    duration_months: clamp(e?.duration_months, 0, 600),
    highlights: arr(e?.highlights).map((h) => str(h)).filter(Boolean),
  }));

  const statedMonths = clamp(input.total_experience_months, 0, 600);
  const summedMonths = experience.reduce((total, e) => total + e.duration_months, 0);

  return {
    name: str(input.name),
    contact: {
      email: str(input.contact?.email),
      phone: str(input.contact?.phone),
      links: arr(input.contact?.links).map((l) => str(l)).filter(Boolean),
    },
    skills: dedupeBy(skills, (s) => s.name),
    experience,
    projects: arr(input.projects).map((p) => ({
      name: str(p?.name),
      tech: arr(p?.tech).map((t) => canonicalise(normSkill(t))).filter(Boolean),
      one_line: str(p?.one_line),
    })),
    education: {
      degree: str(input.education?.degree),
      field: str(input.education?.field),
      institution: str(input.education?.institution),
      graduation: str(input.education?.graduation),
    },
    total_experience_months: statedMonths || summedMonths,
    _parse_confidence: bad ? 'low' : oneOf(input._parse_confidence, CONFIDENCE, 'medium'),
    _fallback: bad || undefined,
    _error: bad ? str(raw?._error, 'invalid_shape') : undefined,
  };
}

export function validateJd(raw) {
  const bad = Boolean(!raw || typeof raw !== 'object' || raw._error);
  const input = bad ? {} : raw;
  const requirement = (r, defaultWeight) => ({
    skill: canonicalise(normSkill(typeof r === 'string' ? r : r?.skill)),
    why: str(r?.why),
    weight: clamp(r?.weight ?? defaultWeight, 1, 5),
  });

  return {
    role_title: str(input.role_title, 'Unspecified role'),
    seniority: oneOf(input.seniority, SENIORITY, 'junior'),
    must_have: dedupeBy(
      arr(input.must_have).map((r) => requirement(r, 3)).filter((r) => r.skill),
      (r) => r.skill,
    ),
    nice_to_have: dedupeBy(
      arr(input.nice_to_have).map((r) => requirement(r, 1)).filter((r) => r.skill),
      (r) => r.skill,
    ),
    responsibilities: arr(input.responsibilities).map((r) => str(r)).filter(Boolean),
    domain: str(input.domain),
    min_experience_months: clamp(input.min_experience_months, 0, 600),
    _parse_confidence: bad ? 'low' : oneOf(input._parse_confidence, CONFIDENCE, 'medium'),
    _fallback: bad || undefined,
    _error: bad ? str(raw?._error, 'invalid_shape') : undefined,
  };
}

/** Shapes the model's semantic verdicts. The scorer only ever sees this. */
export function validateSemanticVerdicts(raw) {
  const list = Array.isArray(raw) ? raw : arr(raw?.verdicts);
  const out = {};
  for (const v of list) {
    const key = canonicalise(normSkill(v?.requirement));
    if (!key) continue;
    out[key] = {
      verdict: oneOf(v?.verdict, ['semantic', 'adjacent', 'absent'], 'absent'),
      evidence: str(v?.evidence),
      why: str(v?.why),
      source: 'model',
    };
  }
  return out;
}

export function validateMatchResult(result) {
  return {
    ...result,
    overall_score: clamp(Math.round(result.overall_score), 0, 100),
    verdict: oneOf(result.verdict, ['strong', 'moderate', 'weak'], 'weak'),
    matched: arr(result.matched).map((m) => ({
      ...m,
      match_type: oneOf(m.match_type, MATCH_TYPE, 'exact'),
      credit: clamp(m.credit, 0, 1),
    })),
    gaps: arr(result.gaps).map((g) => ({ ...g, severity: oneOf(g.severity, SEVERITY, 'important') })),
  };
}
