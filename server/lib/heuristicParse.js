// The offline parser. USE_STUB=1 runs the whole app through this — no network,
// no key, no canned single response. It is regex and a vocabulary, so it is
// weaker than the model parse (it says so: _parse_confidence "low"), but it is
// a real parse of the real document, which means the demo, the matrix and the
// eval all still work with the wifi off.
import { CATALOGUE_SKILLS } from './courses.js';
import { ALIASES, EQUIVALENCES, canonicalise } from './equivalences.js';
import { normSkill } from './schema.js';

const EXTRA_TERMS = [
  'javascript', 'typescript', 'react', 'node.js', 'express', 'mongodb', 'redux', 'next.js',
  'html', 'css', 'tailwind', 'vue', 'angular', 'svelte', 'graphql', 'rest', 'websockets',
  'socket.io', 'kafka', 'rabbitmq', 'redis', 'postgresql', 'mysql', 'sqlite', 'firebase',
  'docker', 'kubernetes', 'aws', 'gcp', 'azure', 'jenkins', 'github actions', 'ci/cd',
  'linux', 'bash', 'git', 'jest', 'pytest', 'cypress', 'selenium', 'java', 'c++', 'c#',
  'python', 'go', 'rust', 'kotlin', 'swift', 'flutter', 'react native', 'android',
  'pytorch', 'tensorflow', 'keras', 'scikit-learn', 'pandas', 'numpy', 'matplotlib',
  'opencv', 'transformers', 'hugging face', 'langchain', 'openai api', 'rag', 'llm',
  'spark', 'airflow', 'dbt', 'bigquery', 'tableau', 'power bi', 'excel', 'jira', 'figma',
  'microservices', 'system design', 'agile', 'scrum', 'oauth', 'jwt', 'solidity', 'web3',
];

const VOCABULARY = [...new Set([
  ...CATALOGUE_SKILLS,
  ...EXTRA_TERMS.map(normSkill),
  ...ALIASES.flat().map(normSkill),
  // The conceptual requirements a JD actually writes — "event-driven systems",
  // "distributed systems", "system design". These are the ones a keyword
  // checker fails on, so the offline parser has to be able to see them.
  ...EQUIVALENCES.flatMap((rule) => rule.req).map(normSkill),
])].filter((term) => term.length >= 2).sort((a, b) => b.length - a.length);

const SECTION_HEAD = /^\s*(education|experience|work experience|employment|skills|technical skills|projects|certifications|achievements|summary|objective|responsibilities|requirements|qualifications)\b/i;

const sentencesOf = (text) => text
  .split(/\n|(?<=[.;])\s+/)
  .map((line) => line.replace(/^[\s\-*]+/, '').trim())
  .filter((line) => line.length > 2);

/** Whole-word-ish presence test, so "java" does not match "javascript". */
function mentions(text, term) {
  const hay = normSkill(text);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9+#])${escaped}([^a-z0-9+#]|$)`).test(hay);
}

// Generic filler that the vocabulary picks up but that carries no signal as a
// requirement on its own — "REST API" already tells us everything "api" would.
const STOP_TERMS = new Set(['api', 'apis', 'databases', 'database']);

/** "event driven" and "event driven systems" are one requirement, not two. */
function dropSubsumed(terms) {
  const parts = terms.map((term) => term.split(/[ ./]+/).filter(Boolean));
  return terms.filter((_, i) => !parts.some((other, j) =>
    j !== i && other.length > parts[i].length
    && other.some((_, k) => parts[i].every((token, m) => other[k + m] === token))));
}

const foundTerms = (text) => dropSubsumed([...new Set(
  VOCABULARY
    .filter((term) => mentions(text, term))
    .map(canonicalise)
    .filter((term) => !STOP_TERMS.has(term)),
)]);

function sectionBody(text, names) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => names.some((n) => new RegExp(`^\\s*${n}\\b`, 'i').test(line.trim())));
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => SECTION_HEAD.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "Jun 2023 – Aug 2024" / "2022-2024" / "May 2024 - Present" -> months */
function durationMonths(line) {
  const range = line.match(
    /((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*)?((?:19|20)\d{2})\s*(?:-|–|—|to)\s*((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*)?((?:19|20)\d{2}|present|current|now)/i,
  );
  if (!range) return 0;
  const monthIndex = (token) => (token ? Math.max(0, MONTHS.indexOf(token.trim().toLowerCase().slice(0, 3))) : 0);
  const startYear = Number(range[2]);
  const endYear = /present|current|now/i.test(range[4]) ? new Date().getFullYear() : Number(range[4]);
  const months = (endYear - startYear) * 12 + (monthIndex(range[3]) - monthIndex(range[1]));
  return Math.max(1, Math.min(600, months));
}

export function heuristicParseResume(text) {
  const email = (text.match(/[\w.+-]+@[\w-]+\.[\w.]{2,}/) || [''])[0];
  const phone = (text.match(/(\+?\d[\d\s().-]{7,}\d)/) || [''])[0].trim();
  const links = [...text.matchAll(/(https?:\/\/\S+|(?:www\.)?(?:github|linkedin)\.com\/\S+)/gi)]
    .map((m) => m[0].replace(/[),.]+$/, ''));

  const firstLines = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 4);
  const name = firstLines.find((line) =>
    line.split(/\s+/).length <= 4 && /^[A-Za-z][A-Za-z.'\- ]+$/.test(line) && !/resume|curriculum/i.test(line)) || '';

  const experienceBody = sectionBody(text, ['experience', 'work experience', 'employment', 'internships?']);
  const projectsBody = sectionBody(text, ['projects', 'personal projects', 'academic projects']);
  const educationBody = sectionBody(text, ['education', 'academics']);
  const evidenceZone = `${experienceBody}\n${projectsBody}`;
  const evidenceSentences = sentencesOf(evidenceZone);

  const skills = foundTerms(text).map((term) => {
    const evidence = evidenceSentences.find((line) => mentions(line, term)) || '';
    return {
      name: term,
      evidence: evidence.slice(0, 220),
      // Claimed in a bullet about work you did = strong. Listed in a skills
      // dump and nowhere else = mentioned. That distinction is the point.
      strength: evidence ? 'strong' : 'mentioned',
    };
  });

  const experienceLines = sentencesOf(experienceBody);
  const experience = experienceLines
    .filter((line) => durationMonths(line) > 0)
    .slice(0, 6)
    .map((line) => {
      const [titlePart, orgPart] = line.split(/\s+(?:at|@|\||,|-|–)\s+/);
      return {
        title: (titlePart || line).replace(/\(?\b(19|20)\d{2}\b.*$/, '').trim().slice(0, 80),
        org: (orgPart || '').replace(/\(?\b(19|20)\d{2}\b.*$/, '').trim().slice(0, 80),
        duration_months: durationMonths(line),
        highlights: experienceLines.filter((l) => l !== line && l.length > 30).slice(0, 4),
      };
    });

  const projects = sentencesOf(projectsBody)
    .filter((line) => line.length > 20)
    .slice(0, 5)
    .map((line) => ({
      name: line.split(/[-:|–—]/)[0].trim().slice(0, 60),
      tech: foundTerms(line),
      one_line: line.slice(0, 220),
    }));

  const degree = (educationBody.match(/\b(b\.?tech|b\.?e\.?|b\.?sc|bachelor[s']*|m\.?tech|m\.?sc|master[s']*|mba|phd|diploma)\b[^\n,]*/i) || [''])[0].trim();

  return {
    name,
    contact: { email, phone, links: [...new Set(links)].slice(0, 5) },
    skills,
    experience,
    projects,
    education: {
      degree,
      field: (educationBody.match(/\b(computer science|information technology|electronics|mechanical|civil|electrical|data science|mathematics|cse|ece)\b/i) || [''])[0],
      institution: sentencesOf(educationBody).find((l) => /university|college|institute|school|iit|nit/i.test(l))?.slice(0, 80) || '',
      graduation: (educationBody.match(/\b(19|20)\d{2}\b/) || [''])[0],
    },
    total_experience_months: experience.reduce((sum, e) => sum + e.duration_months, 0),
    _parse_confidence: 'low', // heuristic, and we say so rather than pretending
    _parsed_by: 'heuristic',
  };
}

export function heuristicParseJd(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const roleTitle = lines[0]?.slice(0, 90) || 'Unspecified role';

  const requiredBody = sectionBody(text, ['requirements', 'required', 'must have', 'must-have', 'qualifications', 'what you need', 'skills']) || text;
  const niceBody = sectionBody(text, ['nice to have', 'nice-to-have', 'preferred', 'bonus', 'good to have', 'plus']);
  const responsibilitiesBody = sectionBody(text, ['responsibilities', "what you'll do", 'the role', 'about the role']);

  const niceTerms = new Set(foundTerms(niceBody));
  const mustTerms = foundTerms(requiredBody).filter((term) => !niceTerms.has(term));

  const years = text.match(/(\d+)\s*\+?\s*(?:-|–|to)?\s*\d*\s*year/i);
  const monthsMatch = text.match(/(\d+)\s*\+?\s*month/i);
  const seniority = /\bintern(ship)?\b/i.test(text) ? 'intern'
    : /\b(senior|lead|staff|principal)\b/i.test(text) ? 'senior'
      : /\b(mid-level|3\+ years|4\+ years|5\+ years)\b/i.test(text) ? 'mid' : 'junior';

  const requirement = (skill, weight, why) => ({ skill, why, weight });

  return {
    role_title: roleTitle,
    seniority,
    must_have: mustTerms.slice(0, 12).map((term) => requirement(term, 3, `Listed under requirements for ${roleTitle}.`)),
    nice_to_have: [...niceTerms].slice(0, 8).map((term) => requirement(term, 1, `Listed as preferred for ${roleTitle}.`)),
    responsibilities: sentencesOf(responsibilitiesBody).slice(0, 6),
    domain: (text.match(/\b(fintech|healthtech|e-?commerce|edtech|saas|gaming|logistics|security)\b/i) || [''])[0],
    min_experience_months: years ? Number(years[1]) * 12 : monthsMatch ? Number(monthsMatch[1]) : 0,
    _parse_confidence: 'low',
    _parsed_by: 'heuristic',
  };
}

export { VOCABULARY, foundTerms, mentions };
