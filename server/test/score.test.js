// The scorer is the module I have to be able to explain line by line, so it is
// the module with tests. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreMatch, computeCredit, exactMatches, keywordBaseline,
  experienceFit, atsHygiene, verdictFor, resumeSkillNames, CREDIT,
} from '../lib/score.js';
import { validateResume, validateJd } from '../lib/schema.js';

const resume = validateResume({
  name: 'Nathi Michael',
  contact: { email: 'a@example.com', phone: '+91 98765 43210', links: [] },
  skills: [
    { name: 'React', evidence: 'Built the Oryx dashboard in React', strength: 'strong' },
    { name: 'Node.js', evidence: 'Wrote 14 Express endpoints', strength: 'strong' },
    { name: 'WebSockets', evidence: 'Built real-time chat over WebSockets for 3000 users', strength: 'strong' },
    { name: 'Docker', evidence: 'Containerised the service with Docker', strength: 'strong' },
  ],
  experience: [{ title: 'Backend Intern', org: 'Hashira', duration_months: 6, highlights: ['Built real-time chat over WebSockets for 3000 users'] }],
  projects: [],
  education: { degree: 'B.Tech', field: 'CSE', institution: 'ACET', graduation: '2027' },
  total_experience_months: 6,
  _parse_confidence: 'high',
});

const jd = validateJd({
  role_title: 'Backend Engineer',
  seniority: 'junior',
  must_have: [
    { skill: 'node.js', why: 'The service is Node', weight: 3 },
    { skill: 'event-driven systems', why: 'Notifications are queue-driven', weight: 3 },
    { skill: 'kubernetes', why: 'We deploy on k8s', weight: 3 },
  ],
  nice_to_have: [{ skill: 'redis', why: 'Caching layer', weight: 1 }],
  responsibilities: [],
  domain: 'travel',
  min_experience_months: 12,
  _parse_confidence: 'high',
});

test('case 1: an exact keyword match earns full credit', () => {
  assert.equal(exactMatches(resumeSkillNames(resume), { skill: 'node.js' }), true);
  const { credit, match_type } = computeCredit({ skill: 'node.js', weight: 3 }, resume, {});
  assert.equal(credit, CREDIT.exact);
  assert.equal(match_type, 'exact');
});

test('case 2: the WebSockets/event-driven case — the reason this project exists', () => {
  // No exact keyword. An ATS scores this zero.
  assert.equal(exactMatches(resumeSkillNames(resume), { skill: 'event-driven systems' }), false);
  // We credit it at 0.8, from the rule table, with no model call.
  const { credit, match_type, evidence, source } = computeCredit(
    { skill: 'event-driven systems', weight: 3 },
    resume,
    { 'event driven systems': { verdict: 'semantic', evidence: 'Built real-time chat over WebSockets for 3000 users', why: 'websockets', source: 'rule' } },
  );
  assert.equal(credit, CREDIT.semantic);
  assert.equal(match_type, 'semantic');
  assert.equal(source, 'rule');
  assert.match(evidence, /WebSockets/); // we can always show the sentence
});

test('case 3: a genuinely absent must-have scores zero and becomes a blocking gap', () => {
  const verdicts = {
    'event driven systems': { verdict: 'semantic', evidence: 'Built real-time chat over WebSockets for 3000 users', why: '', source: 'rule' },
    kubernetes: { verdict: 'adjacent', evidence: 'Containerised the service with Docker', why: 'docker', source: 'rule' },
  };
  const result = scoreMatch(resume, jd, verdicts, [], { resume_id: 'r1', jd_id: 'j1' });

  // must_have = (1.0*3 + 0.8*3 + 0.5*3) / 9 = 0.766...
  assert.equal(result.sub_scores.must_have_coverage, 0.77);
  assert.equal(result.sub_scores.nice_to_have_coverage, 0);   // redis absent
  assert.equal(result.sub_scores.experience_fit, 0.5);        // 6 of 12 months
  assert.equal(result.sub_scores.ats_hygiene, 1);             // no checks supplied
  // 100*(0.5*0.7667 + 0.2*0 + 0.2*0.5 + 0.1*1) = 58.3 -> 58
  assert.equal(result.overall_score, 58);
  assert.equal(result.verdict, 'moderate');

  const kubernetesGap = result.gaps.find((g) => g.requirement === 'kubernetes');
  assert.equal(kubernetesGap.severity, 'important'); // partial credit, still a gap
  assert.equal(result.gaps.find((g) => g.requirement === 'redis').severity, 'minor');
});

test('the same inputs always produce the identical score', () => {
  const runs = new Set();
  for (let i = 0; i < 25; i += 1) runs.add(scoreMatch(resume, jd, {}, []).overall_score);
  assert.equal(runs.size, 1);
});

test('we beat the keyword baseline on the same pair', () => {
  const verdicts = {
    'event driven systems': { verdict: 'semantic', evidence: 'Built real-time chat over WebSockets', why: '', source: 'rule' },
  };
  const ours = scoreMatch(resume, jd, verdicts, []).overall_score;
  const baseline = keywordBaseline(resume, jd).overall_score;
  assert.ok(ours > baseline, `expected ${ours} > ${baseline}`);
  assert.equal(baseline, 25); // only node.js of 4 requirements literally appears
});

test('experience_fit does not punish a fresher for an internship that asks for nothing', () => {
  assert.equal(experienceFit(0, 0), 1);   // guard: the literal formula gives 0 here
  assert.equal(experienceFit(6, 12), 0.5);
  assert.equal(experienceFit(24, 12), 1); // capped, no bonus for over-qualifying
});

test('ats_hygiene weights a blocking violation above a minor one', () => {
  const oneBlocking = atsHygiene([
    { id: 'a', passed: false, severity: 'blocking' },
    { id: 'b', passed: true, severity: 'minor' },
  ]);
  const oneMinor = atsHygiene([
    { id: 'a', passed: true, severity: 'blocking' },
    { id: 'b', passed: false, severity: 'minor' },
  ]);
  assert.ok(oneBlocking < oneMinor);
  assert.equal(atsHygiene([]), 1);
});

test('verdict thresholds are exactly 75 and 50', () => {
  assert.equal(verdictFor(75), 'strong');
  assert.equal(verdictFor(74), 'moderate');
  assert.equal(verdictFor(50), 'moderate');
  assert.equal(verdictFor(49), 'weak');
});

test('an empty requirement list does not divide by zero', () => {
  const empty = validateJd({ role_title: 'x', must_have: [], nice_to_have: [] });
  const result = scoreMatch(resume, empty, {}, []);
  assert.equal(result.sub_scores.must_have_coverage, 1);
  assert.ok(Number.isFinite(result.overall_score));
});

test('garbage from the model still produces a renderable result', () => {
  const broken = validateResume({ _error: 'unparseable_json', _raw: 'sorry!' });
  const result = scoreMatch(broken, jd, {}, []);
  assert.equal(broken._fallback, true);
  assert.equal(broken._parse_confidence, 'low');
  assert.ok(Number.isFinite(result.overall_score));
  assert.equal(result.verdict, 'weak');
});

test('the must-have gate: no verdict better than weak when most must-haves are missing', () => {
  const thinJd = validateJd({
    role_title: 'Backend Engineer',
    must_have: [
      { skill: 'kubernetes', why: '', weight: 3 },
      { skill: 'terraform', why: '', weight: 3 },
      { skill: 'node.js', why: '', weight: 3 },
    ],
    nice_to_have: [{ skill: 'docker', why: '', weight: 1 }],
    min_experience_months: 0, // no experience bar -> experience_fit = 1
  });
  const result = scoreMatch(resume, thinJd, {}, []);
  // 1 of 3 must-haves, but the 30-point floor puts the raw score above 50.
  assert.ok(result.overall_score >= 50, `floor effect: ${result.overall_score}`);
  assert.equal(result.sub_scores.must_have_coverage, 0.33);
  assert.equal(result.verdict, 'weak'); // the gate catches it
});
