// The bot's brain, with no idea which chat app it is in. Telegram and the web
// widget both drive this same state machine, so a fix to the flow fixes both.
import { parseResume, parseJd } from './parse.js';
import { extractFromBuffer, extractFromText, ExtractionError } from './extract.js';
import { matchPair } from './pipeline.js';
import { newStats } from './model.js';
import { CREDIT } from './score.js';

const sessions = new Map(); // chatId -> { resume, jd, mode, matrixResumes, matrixJds }

const HELP = [
  'HOW THIS WORKS',
  '',
  '  1. Send me your resume — attach a PDF or DOCX, or paste the text.',
  '  2. Send a job description the same way.',
  '  3. I reply with a score out of 100 and what to fix.',
  '',
  'Your resume stays loaded, so you can keep sending job descriptions',
  'and compare them without sending the resume again.',
  '',
  'COMMANDS',
  '',
  '  /matrix   compare up to 5 resumes against up to 5 jobs at once',
  '  /done     run the grid once you are in /matrix mode',
  '  /reset    forget my resume and start over',
  '  /help     show this again',
].join('\n');

const getSession = (chatId) => {
  if (!sessions.has(chatId)) sessions.set(chatId, { mode: 'single', matrixResumes: [], matrixJds: [] });
  return sessions.get(chatId);
};

export const resetSession = (chatId) => sessions.delete(chatId);
export const sessionCount = () => sessions.size;

/**
 * A resume and a JD look similar as raw text. Rather than guessing, we ask —
 * except that the first document is always the resume, which is what the
 * prompt tells the user to send, and covers the demo path with no question.
 */
function looksLikeJd(text) {
  const jdSignals = /(responsibilities|requirements|nice to have|we are looking for|about the role|you will|qualifications|apply now|job type)/gi;
  const resumeSignals = /(education|projects|internship|cgpa|gpa|b\.?tech|achievements|curriculum vitae)/gi;
  return (text.match(jdSignals) || []).length > (text.match(resumeSignals) || []).length;
}

/**
 * @param {{chatId: string, text?: string, file?: {buffer: Buffer, filename: string}}} message
 * @returns {Promise<{text: string, result?: object, matrix?: object}>}
 */
export async function handleMessage(message) {
  const { chatId } = message;
  const session = getSession(chatId);
  const command = (message.text || '').trim().toLowerCase();

  if (command === '/start') {
    resetSession(chatId);
    return { text: `Send me your resume to start.\n\n${HELP}` };
  }
  if (command === '/help') return { text: HELP };
  if (command === '/reset') {
    resetSession(chatId);
    return { text: 'Cleared. Send a resume when you are ready.' };
  }
  if (command === '/matrix') {
    session.mode = 'matrix';
    session.matrixResumes = [];
    session.matrixJds = [];
    return { text: 'Matrix mode. Send up to 5 resumes and up to 5 job descriptions, one message each, then send /done.' };
  }
  if (command === '/done') {
    if (session.mode !== 'matrix') return { text: 'Not in matrix mode. Send /matrix first.' };
    return runMatrix(session);
  }

  // ---- get text out of whatever arrived --------------------------------
  let text;
  let filename = '';
  try {
    if (message.file) {
      filename = message.file.filename;
      text = (await extractFromBuffer(message.file.buffer, filename)).text;
    } else {
      text = extractFromText(message.text || '').text;
    }
  } catch (error) {
    if (error instanceof ExtractionError) return { text: error.message };
    throw error;
  }

  if (session.mode === 'matrix') {
    if (looksLikeJd(text)) {
      if (session.matrixJds.length >= 5) return { text: 'Already have 5 job descriptions — that is the cap. Send /done.' };
      session.matrixJds.push({ label: filename || `Role ${String.fromCharCode(65 + session.matrixJds.length)}`, text });
    } else {
      if (session.matrixResumes.length >= 5) return { text: 'Already have 5 resumes — that is the cap. Send /done.' };
      session.matrixResumes.push({ label: filename || `Resume ${String.fromCharCode(65 + session.matrixResumes.length)}`, text });
    }
    return { text: `Got it. ${session.matrixResumes.length} resume(s), ${session.matrixJds.length} job description(s). Send /done to run the grid.` };
  }

  // ---- single-pair flow --------------------------------------------------
  const stats = newStats();
  if (!session.resume) {
    const parsed = await parseResume(text, stats);
    session.resume = { ...parsed, text };
    const skills = parsed.parsed.skills.slice(0, 6).map((s) => s.name).join(', ');
    return {
      text: [
        `Got your resume${parsed.cached ? ' (I had already read this one, so it was instant)' : ''}.`,
        `I found ${parsed.parsed.skills.length} skills${skills ? `, including ${skills}` : ''}.`,
        '',
        'Now send a job description and I will score the match.',
      ].join('\n'),
    };
  }

  const parsed = await parseJd(text, stats);
  session.jd = { ...parsed, text };
  const result = await matchPair(
    { id: session.resume.id, parsed: session.resume.parsed, text: session.resume.text },
    { id: session.jd.id, parsed: session.jd.parsed, text: session.jd.text },
    { stats },
  );
  session.jd = null; // next JD scores against the same resume
  return { text: formatResult(result), result: { ...result, stats } };
}

async function runMatrix(session) {
  if (!session.matrixResumes.length || !session.matrixJds.length) {
    return { text: 'I need at least one resume and one job description before I can build a grid.' };
  }
  const stats = newStats();
  const startedAt = Date.now();

  // Pasted text has no filename, so the placeholder labels are "Resume A" /
  // "Role B". Once parsed we know the candidate's name and the role title —
  // use those, because a grid of A/B/C tells the user nothing.
  const resumes = [];
  for (const input of session.matrixResumes) {
    const parsed = await parseResume(input.text, stats);
    resumes.push({ ...parsed, label: betterLabel(input.label, parsed.parsed.name), text: input.text });
  }
  const jds = [];
  for (const input of session.matrixJds) {
    const parsed = await parseJd(input.text, stats);
    jds.push({ ...parsed, label: betterLabel(input.label, parsed.parsed.role_title), text: input.text });
  }

  const matrix = [];
  for (const resume of resumes) {
    const row = [];
    for (const jd of jds) {
      const cell = await matchPair(
        { id: resume.id, parsed: resume.parsed, text: resume.text },
        { id: jd.id, parsed: jd.parsed, text: jd.text },
        { withAdvice: false, stats },
      );
      row.push(cell.overall_score);
    }
    matrix.push(row);
  }

  const lines = [];
  const best = { score: -1 };
  matrix.forEach((row, i) => row.forEach((score, j) => {
    if (score > best.score) Object.assign(best, { score, resume: resumes[i].label, jd: jds[j].label });
  }));

  lines.push('YOUR FIT GRID', '');
  // One block per job rather than a wide table: a 5-column table wraps into
  // nonsense on a phone, and the question is "who wins this job" anyway.
  jds.forEach((jd, j) => {
    const column = matrix.map((row) => row[j]);
    const top = Math.max(...column);
    lines.push(`${jd.label}`);
    resumes.forEach((resume, i) => {
      const score = column[i];
      const marker = score === top ? '>' : ' ';
      lines.push(`  ${marker} ${String(score).padStart(3)}/100  ${resume.label}`);
    });
    lines.push('');
  });

  lines.push('-'.repeat(34), 'WHAT THIS TELLS YOU', '');
  const wins = new Map();
  jds.forEach((jd, j) => {
    const column = matrix.map((row) => row[j]);
    const winner = resumes[column.indexOf(Math.max(...column))].label;
    wins.set(winner, (wins.get(winner) || 0) + 1);
  });
  for (const [label, count] of [...wins.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${label} is your best option for ${count} of the ${jds.length} job${jds.length === 1 ? '' : 's'}.`);
  }
  lines.push('', `  Best single match: ${best.resume} for ${best.jd}, at ${best.score}/100.`);
  lines.push('  A ">" marks the resume that wins each job.');

  lines.push('', '-'.repeat(34), 'WHAT IT COST', '');
  lines.push(`  ${stats.model_calls} AI call${stats.model_calls === 1 ? '' : 's'} for ${resumes.length} resume${resumes.length === 1 ? '' : 's'} against ${jds.length} job${jds.length === 1 ? '' : 's'}.`);
  lines.push(`  A tool that scored each pair separately would have made ${resumes.length * jds.length}.`);
  lines.push('  We read each document once, then compare the summaries.');
  if (stats.cache_hits) lines.push(`  ${stats.cache_hits} document(s) were already saved, so they cost nothing.`);
  lines.push(`  Took ${Date.now() - startedAt}ms.`);

  return { text: lines.join('\n'), matrix: { matrix, resumes: resumes.map((r) => r.label), jds: jds.map((j) => j.label), stats } };
}

/** Keep a user-supplied label; replace a generic placeholder with a real one. */
function betterLabel(label, parsedName) {
  const isPlaceholder = /^(Resume|Role) [A-E]$/.test(label);
  const clean = String(parsedName || '').trim();
  return isPlaceholder && clean ? shorten(clean, 28) : label;
}

const shorten = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}.` : text);

/**
 * Plain text for a chat window.
 *
 * Written for a final-year student, not for a judge: no "must-have coverage",
 * no "ATS hygiene", no bare credit numbers like 0.8. Every number is followed
 * by what it means, and the message ends by saying what to do next.
 */
export function formatResult(result) {
  const meta = result._meta || {};
  const out = [];
  const rule = '-'.repeat(34);

  // --- headline ---------------------------------------------------------
  out.push(`${meta.role_title || 'This role'}`);
  out.push(`Score: ${result.overall_score} out of 100  (${result.verdict} match)`);
  out.push('');
  out.push(VERDICT_ADVICE[result.verdict] || '');

  const full = result.matched.filter((m) => m.credit >= CREDIT.semantic).length;
  const partial = result.matched.filter((m) => m.credit > 0 && m.credit < CREDIT.semantic).length;
  if (meta.requirements_total) {
    out.push(`Of the ${meta.requirements_total} things this job asks for, you fully cover ${full}`
      + `${partial ? ` and partly cover ${partial} more` : ''}.`);
  }

  // --- where the score came from ----------------------------------------
  out.push('', rule, 'WHERE THE SCORE CAME FROM', '');
  const months = meta.experience || {};
  out.push(scoreLine('Skills they require', result.sub_scores.must_have_coverage, 'half your score comes from this'));
  out.push(scoreLine('Skills they prefer', result.sub_scores.nice_to_have_coverage, 'the "nice to have" list'));
  out.push(scoreLine('Experience', result.sub_scores.experience_fit,
    months.required_months
      ? `you have ${readableMonths(months.candidate_months)}, they ask for ${readableMonths(months.required_months)}`
      : 'this role asks for no set amount'));
  out.push(scoreLine('Resume formatting', result.sub_scores.ats_hygiene, 'how well an automated scanner can read your file'));

  // --- the differentiator, explained without jargon ----------------------
  const semantic = result.matched.filter((m) => m.match_type !== 'exact');
  if (semantic.length) {
    out.push('', rule, 'COUNTED EVEN THOUGH YOU NEVER USED THEIR WORDS', '');
    out.push('A keyword scanner gives these zero. We read the evidence:', '');
    for (const match of semantic.slice(0, 3)) {
      out.push(`  They want: ${match.requirement}`);
      // Sometimes the only evidence is the skill name itself, with no
      // sentence behind it. Saying 'You wrote: "javascript"' reads like a bug.
      const isSentence = match.evidence.trim().split(/\s+/).length > 3;
      out.push(isSentence
        ? `  You wrote: "${shorten(match.evidence, 150)}"`
        : `  You list:  ${match.evidence}`);
      out.push(`  ${match.match_type === 'semantic' ? 'That is the same work under a different name.' : 'Related, so it counts for part marks.'}`);
      out.push('');
    }
  }

  // --- gaps -------------------------------------------------------------
  // Two different problems, and calling both "missing" is what made the old
  // output confusing: a skill credited 0.8 above was also listed as missing
  // below. Absent means it is not there at all; thin means it is there but
  // nothing on the resume shows it being used.
  const absent = result.gaps.filter((g) => g.credit === 0 && g.severity !== 'minor');
  const thin = result.gaps.filter((g) => g.credit === CREDIT.claimed && g.severity !== 'minor');

  if (absent.length) {
    out.push(rule, "WHAT'S MISSING", '');
    for (const gap of absent.slice(0, 6)) {
      out.push(`  ${gap.requirement} — ${gap.severity === 'blocking' ? 'they call this essential' : 'they ask for it'}, and it is not on your resume`);
    }
    out.push('');
  }

  if (thin.length) {
    out.push(rule, 'WHERE YOUR EVIDENCE IS THIN', '');
    out.push('You have these, but nothing on the resume shows you using them,', 'so they scored part marks instead of full:', '');
    for (const gap of thin.slice(0, 6)) out.push(`  ${gap.requirement}`);
    out.push('');
  }

  // --- courses ----------------------------------------------------------
  if (result.suggested_courses.length) {
    out.push(rule, 'WHAT TO LEARN', '');
    for (const course of result.suggested_courses.slice(0, 3)) {
      out.push(`  ${course.title}`);
      out.push(`    ${course.provider}`);
      out.push(`    ${course.rationale}`);
      out.push('');
    }
  }

  // --- rewrites ---------------------------------------------------------
  if (result.resume_improvements.length) {
    out.push(rule, 'HOW TO IMPROVE YOUR RESUME', '');
    for (const item of result.resume_improvements) {
      out.push(`  In "${shorten(item.target, 60)}"`);
      out.push(`    Problem: ${item.issue}`);
      out.push(`    Try:     ${item.suggested_rewrite}`);
      out.push('');
    }
  }

  // --- file problems ----------------------------------------------------
  if (result.ats_issues.length) {
    out.push(rule, 'PROBLEMS A RESUME SCANNER WILL HIT', '');
    for (const issue of result.ats_issues.slice(0, 4)) out.push(`  ${issue}`);
    out.push('');
  }

  if (meta.degraded) {
    out.push(rule);
    out.push('Heads up: the AI was unreachable, so part of this used simpler');
    out.push('backup rules. The score is rougher than usual.');
    out.push('');
  }

  // --- what to do next --------------------------------------------------
  out.push(rule, 'WHAT NOW', '');
  out.push('  Send another job description to score this same resume');
  out.push('  against it — that costs nothing extra, your resume is saved.');
  out.push('  /matrix  compare several resumes and jobs at once');
  out.push('  /reset   start over with a different resume');

  return out.join('\n');
}

const VERDICT_ADVICE = {
  strong: 'Send it. This one is worth your time.',
  moderate: 'Worth applying, but expect to be asked about the gaps below.',
  weak: 'As it stands this is a long shot. Fix the gaps first, or aim elsewhere.',
};

/** "Skills they require   88%  ####------  half your score comes from this" */
function scoreLine(label, value, explanation) {
  const percent = Math.round(value * 100);
  const filled = Math.round(percent / 10);
  const bar = '#'.repeat(filled) + '.'.repeat(10 - filled);
  return `  ${label.padEnd(20)} ${String(percent).padStart(3)}%  ${bar}\n     ${explanation}`;
}

function readableMonths(months) {
  if (!months) return 'none';
  if (months < 12) return `${months} month${months === 1 ? '' : 's'}`;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return rest ? `${years} yr ${rest} mo` : `${years} year${years === 1 ? '' : 's'}`;
}

