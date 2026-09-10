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
  '  /pdf      download this report as a PDF',
  '  /docx     download this report as a Word document',
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
  if (command === '/pdf' || command === '/docx') {
    const format = command.slice(1);
    if (!session.lastResult) {
      return { text: 'Nothing to export yet. Send a resume and a job description first, then ask for /pdf or /docx.' };
    }
    return {
      text: `Here is your ${format.toUpperCase()} report.`,
      document: { format, result: session.lastResult },
    };
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
  session.lastResult = result; // so /pdf and /docx can export it later
  return {
    text: formatResult(result, 'plain'),
    markdown: formatResult(result, 'markdown'),
    result: { ...result, stats },
  };
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
  // The whole point of the grid is two versions of ONE person's resume, so
  // both sides parse to the same name and the grid reads as nonsense unless
  // we tell them apart. Fall back to what distinguishes them: their skills.
  disambiguate(resumes, (r) => topSkills(r.parsed));
  disambiguate(jds, () => '');

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

  const best = { score: -1 };
  matrix.forEach((row, i) => row.forEach((score, j) => {
    if (score > best.score) Object.assign(best, { score, resume: resumes[i].label, jd: jds[j].label });
  }));

  const wins = new Map();
  jds.forEach((jd, j) => {
    const column = matrix.map((row) => row[j]);
    const winner = resumes[column.indexOf(Math.max(...column))].label;
    wins.set(winner, (wins.get(winner) || 0) + 1);
  });

  // One block per job rather than a wide table: a 5-column table wraps into
  // nonsense on a phone, and the question is "who wins this job" anyway.
  const grid = jds.map((jd, j) => {
    const column = matrix.map((row) => row[j]);
    const top = Math.max(...column);
    return [
      jd.label,
      ...resumes.map((resume, i) => `  ${column[i] === top ? '>' : ' '} ${String(column[i]).padStart(3)}/100  ${resume.label}`),
    ].join('\n');
  }).join('\n\n');

  const ranking = [...wins.entries()].sort((a, b) => b[1] - a[1])
    .map(([label, count]) => `${label} is your best option for ${count} of the ${jds.length} job${jds.length === 1 ? '' : 's'}.`);

  const cost = [
    `${stats.model_calls} AI call${stats.model_calls === 1 ? '' : 's'} for ${resumes.length} resume${resumes.length === 1 ? '' : 's'} against ${jds.length} job${jds.length === 1 ? '' : 's'}.`,
    `A tool that scored each pair separately would have made ${resumes.length * jds.length}.`,
    'We read each document once, then compare the summaries.',
    ...(stats.cache_hits ? [`${stats.cache_hits} document(s) were already saved, so they cost nothing.`] : []),
    `Took ${Date.now() - startedAt}ms.`,
  ];

  const render = (style) => {
    const S = STYLES[style] || STYLES.plain;
    return [
      S.bold('YOUR FIT GRID'),
      S.esc('A ">" marks the resume that wins each job.'),
      S.block(grid),
      S.heading('WHAT THIS TELLS YOU'),
      ...ranking.map((line) => S.esc(line)),
      '',
      S.esc(`Best single match: ${best.resume} for ${best.jd}, at ${best.score}/100.`),
      S.heading('WHAT IT COST'),
      ...cost.map((line) => S.esc(line)),
    ].join('\n');
  };

  return { text: render('plain'), markdown: render('markdown'), matrix: { matrix, resumes: resumes.map((r) => r.label), jds: jds.map((j) => j.label), stats } };
}

/** Appends a distinguishing hint to labels that would otherwise be identical. */
function disambiguate(items, hintOf) {
  const counts = new Map();
  for (const item of items) counts.set(item.label, (counts.get(item.label) || 0) + 1);
  let index = 0;
  for (const item of items) {
    index += 1;
    if (counts.get(item.label) < 2) continue;
    const hint = hintOf(item);
    item.label = hint ? `${item.label} (${hint})` : `${item.label} #${index}`;
  }
}

/** The two or three skills that best characterise a resume, for a label. */
function topSkills(profile) {
  const named = (profile.skills || []).filter((s) => s.strength === 'strong').map((s) => s.name);
  const pool = named.length ? named : (profile.skills || []).map((s) => s.name);
  return pool.slice(0, 2).join('/');
}

/** Keep a user-supplied label; replace a generic placeholder with a real one. */
function betterLabel(label, parsedName) {
  const isPlaceholder = /^(Resume|Role) [A-E]$/.test(label);
  const clean = String(parsedName || '').trim();
  return isPlaceholder && clean ? shorten(clean, 28) : label;
}

const shorten = (text, max) => {
  const clean = String(text ?? '').trim();
  if (clean.length <= max) return clean;
  // Trim back past any dangling punctuation so we never end on "(." or ",…".
  return `${clean.slice(0, max - 1).replace(/[\s(,\-–—:;.]+$/, '')}…`;
};

/**
 * Telegram MarkdownV2 reserves these, and an unescaped one makes the whole
 * message fail to send — so every piece of text that came from a resume, a
 * job ad or the model goes through here before it reaches a template.
 */
const mdEscape = (text) => String(text ?? '').replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');

/**
 * Two renderers, one layout. Telegram gets MarkdownV2 with bold section
 * headings and monospace blocks (which keep the bars aligned on a phone);
 * the web widget gets the same structure as plain text.
 */
const STYLES = {
  plain: {
    esc: (t) => String(t ?? ''),
    bold: (t) => String(t ?? ''),
    italic: (t) => String(t ?? ''),
    heading: (t) => `\n${'-'.repeat(34)}\n${t}\n`,
    block: (t) => t,
    quote: (t) => `  "${t}"`,
  },
  markdown: {
    esc: mdEscape,
    bold: (t) => `*${mdEscape(t)}*`,
    italic: (t) => `_${mdEscape(t)}_`,
    heading: (t) => `\n*${mdEscape(t)}*`,
    // Backticks would close the fence early; nothing else needs escaping here.
    block: (t) => `\`\`\`\n${String(t).replace(/`/g, "'")}\n\`\`\``,
    quote: (t) => `_${mdEscape(`"${t}"`)}_`,
  },
};

/**
 * Plain text for a chat window, or MarkdownV2 for Telegram.
 *
 * Written for a final-year student, not for a judge: no "must-have coverage",
 * no "ATS hygiene", no bare credit numbers. Every number is followed by what
 * it means, and the message ends by saying what to do next.
 */
export function formatResult(result, style = 'plain') {
  const S = STYLES[style] || STYLES.plain;
  const meta = result._meta || {};
  const out = [];

  // --- headline ---------------------------------------------------------
  out.push(S.bold(meta.role_title || 'This role'));
  out.push(`Score: ${S.bold(`${result.overall_score}/100`)} ${S.esc('—')} ${S.esc(`${result.verdict} match`)}`);
  out.push('');
  out.push(S.italic(VERDICT_ADVICE[result.verdict] || ''));

  const full = result.matched.filter((m) => m.credit >= CREDIT.semantic).length;
  const partial = result.matched.filter((m) => m.credit > 0 && m.credit < CREDIT.semantic).length;
  if (meta.requirements_total) {
    out.push(S.esc(`Of the ${meta.requirements_total} things this job asks for, you fully cover ${full}`
      + `${partial ? ` and partly cover ${partial} more` : ''}.`));
  }

  // --- where the score came from ----------------------------------------
  const months = meta.experience || {};
  out.push(S.heading('WHERE THE SCORE CAME FROM'));
  out.push(S.block([
    scoreLine('Skills they require', result.sub_scores.must_have_coverage, 'half of the total score'),
    scoreLine('Skills they prefer', result.sub_scores.nice_to_have_coverage, 'their "nice to have" list'),
    scoreLine('Experience', result.sub_scores.experience_fit, months.required_months
      ? `you have ${readableMonths(months.candidate_months)}, they want ${readableMonths(months.required_months)}`
      : 'this role asks for no set amount'),
    scoreLine('Resume formatting', result.sub_scores.ats_hygiene, 'how well a scanner reads your file'),
  ].join('\n')));

  // --- the differentiator -----------------------------------------------
  const semantic = result.matched.filter((m) => m.match_type !== 'exact');
  if (semantic.length) {
    out.push(S.heading('COUNTED EVEN THOUGH YOU NEVER USED THEIR WORDS'));
    out.push(S.esc('A keyword scanner gives these zero. We read the evidence:'));
    for (const match of semantic.slice(0, 3)) {
      out.push('');
      out.push(`${S.bold(match.requirement)} ${S.esc(`— counted ${match.credit} of 1`)}`);
      const isSentence = String(match.evidence).trim().split(/\s+/).length > 3;
      out.push(isSentence ? S.quote(shorten(match.evidence, 150)) : S.esc(`You list: ${match.evidence}`));
      out.push(S.esc(match.match_type === 'semantic'
        ? 'The same work under a different name.'
        : 'Related, so it earns part marks.'));
    }
  }

  // --- gaps -------------------------------------------------------------
  // Absent and thin are different problems. Calling both "missing" is what
  // made the old output contradict itself.
  const absent = result.gaps.filter((g) => g.credit === 0 && g.severity !== 'minor');
  const thin = result.gaps.filter((g) => g.credit === CREDIT.claimed && g.severity !== 'minor');

  if (absent.length) {
    out.push(S.heading("WHAT'S MISSING"));
    for (const gap of absent.slice(0, 6)) {
      out.push(`${S.esc('•')} ${S.bold(gap.requirement)} ${S.esc(`— ${gap.severity === 'blocking' ? 'they call this essential' : 'they ask for it'}`)}`);
    }
  }

  if (thin.length) {
    out.push(S.heading('WHERE YOUR EVIDENCE IS THIN'));
    out.push(S.esc('Listed on your resume, but nothing shows you using them, so they earned part marks:'));
    out.push(thin.slice(0, 6).map((g) => S.bold(g.requirement)).join(S.esc(', ')));
  }

  // --- courses ----------------------------------------------------------
  if (!result.suggested_courses.length && (absent.length || thin.length)) {
    out.push(S.heading('WHAT TO LEARN'));
    out.push(S.esc(thin.length && !absent.length
      ? 'Nothing, for this role. You already have what they are asking for — what is thin is the evidence, so fix the bullets above rather than taking a course.'
      : 'Nothing in our catalogue closes these particular gaps. We only suggest courses we actually have, so we would rather say nothing than stretch.'));
  }

  if (result.suggested_courses.length) {
    out.push(S.heading('WHAT TO LEARN'));
    for (const course of result.suggested_courses.slice(0, 3)) {
      out.push('');
      out.push(S.bold(course.title));
      out.push(S.esc(`${course.provider} — closes: ${course.closes_gap}`));
      if (course.rationale) out.push(S.italic(course.rationale));
    }
  }

  // --- rewrites ---------------------------------------------------------
  if (result.resume_improvements.length) {
    out.push(S.heading('HOW TO IMPROVE YOUR RESUME'));
    for (const item of result.resume_improvements) {
      out.push('');
      out.push(S.bold(shorten(item.target, 60)));
      out.push(S.esc(`Problem: ${item.issue}`));
      out.push(S.esc(`Try: ${item.suggested_rewrite}`));
    }
  }

  // --- file problems ----------------------------------------------------
  if (result.ats_issues.length) {
    out.push(S.heading('PROBLEMS A RESUME SCANNER WILL HIT'));
    for (const issue of result.ats_issues.slice(0, 4)) out.push(`${S.esc('•')} ${S.esc(issue)}`);
  }

  if (meta.degraded) {
    out.push(S.heading('HEADS UP'));
    out.push(S.esc('The AI was unreachable, so part of this used simpler backup rules. The score is rougher than usual.'));
  }

  // --- what to do next --------------------------------------------------
  out.push(S.heading('WHAT NOW'));
  out.push(S.esc('Send another job description to score this same resume against it — your resume is saved, so it costs nothing extra.'));
  out.push('');
  out.push(`${S.bold('/pdf')} ${S.esc('or')} ${S.bold('/docx')} ${S.esc('download this report as a file')}`);
  out.push(`${S.bold('/matrix')} ${S.esc('compare several resumes and jobs at once')}`);
  out.push(`${S.bold('/reset')} ${S.esc('start over with a different resume')}`);

  return out.join('\n');
}

const VERDICT_ADVICE = {
  strong: 'Send it. This one is worth your time.',
  moderate: 'Worth applying, but expect to be asked about the gaps below.',
  weak: 'As it stands this is a long shot. Fix the gaps first, or aim elsewhere.',
};

/** Rendered inside a monospace block, so the columns actually line up. */
function scoreLine(label, value, explanation) {
  const percent = Math.round(value * 100);
  const filled = Math.round(percent / 10);
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(10 - filled);
  return `${label.padEnd(21)}${String(percent).padStart(3)}%  ${bar}\n  ${explanation}`;
}

function readableMonths(months) {
  if (!months) return 'none';
  if (months < 12) return `${months} month${months === 1 ? '' : 's'}`;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return rest ? `${years} yr ${rest} mo` : `${years} year${years === 1 ? '' : 's'}`;
}

