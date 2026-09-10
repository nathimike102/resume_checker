// The bot's brain, with no idea which chat app it is in. Telegram and the web
// widget both drive this same state machine, so a fix to the flow fixes both.
import { parseResume, parseJd } from './parse.js';
import { extractFromBuffer, extractFromText, ExtractionError } from './extract.js';
import { matchPair } from './pipeline.js';
import { newStats } from './model.js';

const sessions = new Map(); // chatId -> { resume, jd, mode, matrixResumes, matrixJds }

const HELP = [
  'Send me a resume (PDF, DOCX, or just paste the text), then send a job description.',
  'I reply with a fit score out of 100, the gaps, courses that close them, and rewritten bullets.',
  '',
  'Commands:',
  '/start — begin',
  '/matrix — compare several resumes against several jobs (max 5 x 5)',
  '/done — in matrix mode, run the grid',
  '/reset — forget what you have sent me',
  '/help — this message',
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
      text: `Resume read${parsed.cached ? ' (from cache — no model call)' : ''}. I found ${parsed.parsed.skills.length} skills${skills ? `, including ${skills}` : ''}.\n\nNow send the job description.`,
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

  const resumes = [];
  for (const input of session.matrixResumes) {
    const parsed = await parseResume(input.text, stats);
    resumes.push({ ...parsed, label: input.label, text: input.text });
  }
  const jds = [];
  for (const input of session.matrixJds) {
    const parsed = await parseJd(input.text, stats);
    jds.push({ ...parsed, label: input.label, text: input.text });
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

  const lines = ['Fit grid (score out of 100):', ''];
  lines.push(`${''.padEnd(16)}${jds.map((j) => shorten(j.label, 12).padStart(13)).join('')}`);
  matrix.forEach((row, i) => {
    const best = Math.max(...row);
    lines.push(`${shorten(resumes[i].label, 15).padEnd(16)}${row.map((s) => `${s === best ? '*' : ' '}${String(s).padStart(12)}`).join('')}`);
  });
  lines.push('', `${stats.model_calls} model calls for ${resumes.length} resumes x ${jds.length} jobs.`);
  lines.push(`A naive one-call-per-pair tool would have made ${resumes.length * jds.length}.`);
  lines.push(`${stats.cache_hits} parse(s) came from cache. ${Date.now() - startedAt}ms.`);

  return { text: lines.join('\n'), matrix: { matrix, resumes: resumes.map((r) => r.label), jds: jds.map((j) => j.label), stats } };
}

const shorten = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}.` : text);

/** Plain text for a chat window. The web client renders the JSON instead. */
export function formatResult(result) {
  const lines = [];
  lines.push(`${result.overall_score}/100 — ${result.verdict} fit for ${result._meta.role_title}`);
  lines.push('');
  lines.push(`Must-have coverage   ${pct(result.sub_scores.must_have_coverage)}`);
  lines.push(`Nice-to-have         ${pct(result.sub_scores.nice_to_have_coverage)}`);
  lines.push(`Experience fit       ${pct(result.sub_scores.experience_fit)}`);
  lines.push(`ATS hygiene          ${pct(result.sub_scores.ats_hygiene)}`);

  const semantic = result.matched.filter((m) => m.match_type !== 'exact');
  if (semantic.length) {
    lines.push('', 'Credited without the exact keyword:');
    for (const match of semantic.slice(0, 3)) {
      lines.push(`  ${match.requirement} (${match.credit}) — "${shorten(match.evidence, 90)}"`);
    }
  }

  const blocking = result.gaps.filter((g) => g.severity === 'blocking');
  if (blocking.length) {
    lines.push('', `Blocking gaps: ${blocking.map((g) => g.requirement).join(', ')}`);
  }
  if (result.suggested_courses.length) {
    lines.push('', 'Courses that close them:');
    for (const course of result.suggested_courses.slice(0, 3)) {
      lines.push(`  ${course.title} (${course.provider}) — ${course.rationale}`);
    }
  }
  if (result.resume_improvements.length) {
    lines.push('', 'Rewrite these:');
    for (const item of result.resume_improvements) {
      lines.push(`  [${item.target}] ${item.issue}`);
      lines.push(`   -> ${item.suggested_rewrite}`);
    }
  }
  if (result.ats_issues.length) {
    lines.push('', `ATS issues: ${result.ats_issues.slice(0, 3).join(' | ')}`);
  }
  if (result._meta.degraded) {
    lines.push('', 'Note: part of this ran on fallback rules because the model was unavailable. Treat it as low confidence.');
  }
  lines.push('', 'Send another job description to score the same resume against it, or /reset to start over.');
  return lines.join('\n');
}

const pct = (value) => `${Math.round(value * 100)}%`;
