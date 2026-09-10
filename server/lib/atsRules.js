// Deterministic hygiene checks over the RAW resume text. No model, ever.
// Each check returns { id, passed, severity, message }. This is the tier we
// point at when someone asks what the model is actually needed for.

const SECTIONS = ['education', 'experience', 'skills', 'projects'];
const DATE_PATTERN = /(19|20)\d{2}|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*(19|20)?\d{2}/i;

export function runAtsChecks(rawText = '') {
  const text = String(rawText);
  const lower = text.toLowerCase();
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const words = text.split(/\s+/).filter(Boolean);

  const check = (id, passed, severity, message) => ({ id, passed, severity, message });

  const foundSections = SECTIONS.filter((section) => lower.includes(section));

  // Two columns in a PDF usually collapse into lines with a big internal gap.
  const wideGapLines = text.split('\n').filter((line) => /\S {6,}\S/.test(line)).length;

  return [
    check('extractable_text', words.length >= 50, 'blocking',
      'Almost no text could be extracted — this looks like a scanned image, and most ATS parsers will read it as blank.'),
    check('email_present', /[\w.+-]+@[\w-]+\.[\w.]{2,}/.test(text), 'blocking',
      'No email address found. A recruiter cannot reply to this resume.'),
    check('phone_present', /(\+?\d[\d\s().-]{7,}\d)/.test(text), 'important',
      'No phone number found.'),
    check('standard_headings', foundSections.length >= 3, 'important',
      `Missing standard section headings (found ${foundSections.length || 0} of Education / Experience / Skills / Projects). Parsers key off these.`),
    check('parseable_dates', DATE_PATTERN.test(text), 'important',
      'No parseable dates found. Add month/year ranges to roles and projects.'),
    check('single_column', wideGapLines <= Math.max(3, lines.length * 0.15), 'important',
      'Layout looks multi-column — text extraction interleaves the columns and the resume reads as gibberish to a parser.'),
    check('length_reasonable', words.length >= 180 && words.length <= 1200, 'minor',
      `Length is ${words.length} words; aim for roughly 300–900 on a one-page fresher resume.`),
    check('links_present', /(github\.com|linkedin\.com|https?:\/\/)/i.test(text), 'minor',
      'No GitHub or LinkedIn link found.'),
    check('bullets_present', /^[\s]*[-•*•]/m.test(text), 'minor',
      'No bullet points detected. Prose paragraphs are harder to scan and to parse.'),
    check('no_special_glyphs', !/[-]/.test(text), 'minor',
      'Private-use glyphs found (icon fonts). They extract as garbage characters.'),
  ];
}

/** Convenience for the UI: the failures only, worst first. */
export function atsIssues(report) {
  const rank = { blocking: 0, important: 1, minor: 2 };
  return report.filter((c) => !c.passed).sort((a, b) => rank[a.severity] - rank[b.severity]);
}
