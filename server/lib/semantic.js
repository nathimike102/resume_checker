// The one place the model exercises judgement about a match.
//
// Three tiers, cheapest first:
//   1. exact keyword     -> score.js, free
//   2. equivalence table -> equivalences.js, free
//   3. everything left   -> ONE batched model call for the whole list
//
// Tier 3 is one call per (resume, JD) pair regardless of how many
// requirements are unresolved — never one call per requirement.
import { askJson } from './model.js';
import { SEMANTIC_SCHEMA } from './jsonSchemas.js';
import { validateSemanticVerdicts, normSkill } from './schema.js';
import { exactMatches, resumeSkillNames, resumeEvidenceText, ruleSemanticVerdict } from './score.js';

const SYSTEM = 'You judge whether a resume contains real evidence of a job requirement. You are strict: you credit demonstrated work, not adjacent vocabulary.';

export function semanticPrompt(profile, requirements) {
  const evidence = [
    ...(profile.experience || []).flatMap((e) => (e.highlights || []).map((h) => `- ${h}`)),
    ...(profile.projects || []).map((p) => `- ${p.name}: ${p.one_line} [${(p.tech || []).join(', ')}]`),
    ...(profile.skills || []).filter((s) => s.evidence).map((s) => `- ${s.name}: ${s.evidence}`),
  ].join('\n');

  return `For each requirement below, decide whether this candidate's resume shows evidence of it.

VERDICTS
- "semantic": the resume describes doing this thing under a different name. Example: requirement "event-driven systems", resume says "built real-time chat over WebSockets" -> semantic.
- "adjacent": related and transferable, but not the same thing. Example: requirement "Kubernetes", resume says "Docker" -> adjacent.
- "absent": no real evidence. Say absent when unsure. A skill listed in a skills dump with no supporting work is absent for this purpose.

RULES
- "evidence" must be copied verbatim from the resume lines below. If you cannot copy a line, the verdict is "absent" and evidence is "".
- Never credit a requirement because the resume mentions the same broad field.
- Return a verdict for every requirement, using the requirement string exactly as given.

REQUIREMENTS
${requirements.map((r) => `- ${r.skill}`).join('\n')}

RESUME EVIDENCE
${evidence || '(no evidence lines extracted)'}

CANDIDATE SKILL LIST: ${resumeSkillNames(profile).join(', ') || '(none)'}`;
}

/**
 * @returns {{ verdicts: object, resolved_by_rule: number, resolved_by_model: number, model_called: boolean }}
 */
export async function resolveSemantics(profile, jd, stats) {
  const requirements = [...(jd.must_have || []), ...(jd.nice_to_have || [])];
  const skills = resumeSkillNames(profile);
  const verdicts = {};
  const unresolved = [];

  for (const requirement of requirements) {
    if (exactMatches(skills, requirement)) continue; // tier 1, free
    const rule = ruleSemanticVerdict(requirement, profile); // tier 2, free
    if (rule) {
      verdicts[normSkill(requirement.skill)] = rule;
      if (stats) stats.rule_resolved += 1;
      continue;
    }
    unresolved.push(requirement);
  }

  if (!unresolved.length) {
    return { verdicts, resolved_by_rule: Object.keys(verdicts).length, resolved_by_model: 0, model_called: false };
  }

  // Tier 3: one call for the whole remaining list.
  const raw = await askJson(semanticPrompt(profile, unresolved), {
    system: SYSTEM,
    schema: SEMANTIC_SCHEMA,
    stats,
  });

  if (raw?._error) {
    // No model: everything unresolved stays absent. The score drops, honestly,
    // and the response is flagged so the UI can say why.
    for (const requirement of unresolved) {
      verdicts[normSkill(requirement.skill)] = {
        verdict: 'absent', evidence: '', why: 'Not checked — semantic matching unavailable.', source: 'fallback',
      };
    }
    return {
      verdicts,
      resolved_by_rule: Object.keys(verdicts).length - unresolved.length,
      resolved_by_model: 0,
      model_called: true,
      _fallback: true,
      _error: raw._error,
    };
  }

  const judged = validateSemanticVerdicts(raw);
  let modelResolved = 0;
  for (const requirement of unresolved) {
    const key = normSkill(requirement.skill);
    verdicts[key] = judged[key] || { verdict: 'absent', evidence: '', why: 'No verdict returned.', source: 'model' };
    // A verdict is only worth anything if it came with a line from the resume.
    if (verdicts[key].verdict !== 'absent' && !verdicts[key].evidence) {
      verdicts[key] = { verdict: 'absent', evidence: '', why: 'Claimed a match but quoted no evidence.', source: 'model' };
    }
    modelResolved += 1;
  }
  if (stats) stats.model_resolved += modelResolved;

  return {
    verdicts,
    resolved_by_rule: Object.keys(verdicts).length - modelResolved,
    resolved_by_model: modelResolved,
    model_called: true,
  };
}

/** Offline equivalent: tiers 1 and 2 only. Used by USE_STUB and by /api/eval. */
export function resolveSemanticsOffline(profile, jd, stats) {
  const requirements = [...(jd.must_have || []), ...(jd.nice_to_have || [])];
  const skills = resumeSkillNames(profile);
  const verdicts = {};
  let ruleResolved = 0;
  for (const requirement of requirements) {
    if (exactMatches(skills, requirement)) continue;
    const rule = ruleSemanticVerdict(requirement, profile);
    if (rule) {
      verdicts[normSkill(requirement.skill)] = rule;
      ruleResolved += 1;
      if (stats) stats.rule_resolved += 1;
    }
  }
  return { verdicts, resolved_by_rule: ruleResolved, resolved_by_model: 0, model_called: false };
}

export { resumeEvidenceText };
