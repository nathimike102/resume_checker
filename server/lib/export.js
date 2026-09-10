// The fit report as a file the user can keep: PDF or DOCX.
//
// Both are built from the same MatchResult and lay out the same sections, so
// what you download matches what the bot said. Both libraries are pure JS, and
// both builders are optional in the same way the image renderer is: if a
// library is missing, the caller gets null and falls back to text.

import { CREDIT } from './score.js';

const SECTION_GAP = 14;
const INK = '#16191d';
const MUTED = '#6b7280';
const LINE = '#e5e7eb';
const ACCENT = '#1c4f9c';
const VERDICT_COLOUR = { strong: '#1a7f4b', moderate: '#b26a00', weak: '#b3261e' };

/** Everything both formats need, derived once so they cannot disagree. */
export function reportModel(result) {
  const meta = result._meta || {};
  const months = meta.experience || {};
  return {
    title: meta.role_title || 'Fit report',
    candidate: meta.candidate_name || '',
    score: result.overall_score,
    verdict: result.verdict,
    colour: VERDICT_COLOUR[result.verdict] || MUTED,
    components: [
      ['Skills they require', result.sub_scores.must_have_coverage, 'half of the total score'],
      ['Skills they prefer', result.sub_scores.nice_to_have_coverage, 'their "nice to have" list'],
      ['Experience', result.sub_scores.experience_fit, months.required_months
        ? `you have ${readable(months.candidate_months)}, they want ${readable(months.required_months)}`
        : 'this role asks for no set amount'],
      ['Resume formatting', result.sub_scores.ats_hygiene, 'how well a scanner reads your file'],
    ],
    semantic: result.matched.filter((m) => m.match_type !== 'exact'),
    absent: result.gaps.filter((g) => g.credit === 0 && g.severity !== 'minor'),
    // Only the "claimed" tier: listed but never shown in use. Semantic and
    // adjacent partials are already explained above, and repeating them here
    // as "thin evidence" contradicts the section that just credited them.
    thin: result.gaps.filter((g) => g.credit === CREDIT.claimed && g.severity !== 'minor'),
    courses: result.suggested_courses || [],
    improvements: result.resume_improvements || [],
    atsIssues: result.ats_issues || [],
    baseline: meta.keyword_baseline?.overall_score,
    degraded: Boolean(meta.degraded),
  };
}

function readable(months) {
  if (!months) return 'none';
  if (months < 12) return `${months} month${months === 1 ? '' : 's'}`;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return rest ? `${years} yr ${rest} mo` : `${years} year${years === 1 ? '' : 's'}`;
}

export const fileBase = (result) => {
  const meta = result._meta || {};
  const slug = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return [slug(meta.candidate_name) || 'resume', slug(meta.title || meta.role_title) || 'fit-report']
    .filter(Boolean).join('-').slice(0, 60) || 'fit-report';
};

// --- PDF ---------------------------------------------------------------

/** @returns {Promise<Buffer|null>} */
export async function buildPdf(result) {
  let PDFDocument;
  try {
    PDFDocument = (await import('pdfkit')).default;
  } catch (error) {
    console.warn('[export] pdfkit unavailable:', error.message);
    return null;
  }

  const model = reportModel(result);
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: model.title } });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve) => doc.on('end', resolve));

  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const left = doc.page.margins.left;

  // Header
  doc.fillColor(INK).fontSize(20).font('Helvetica-Bold').text(model.title, { width });
  if (model.candidate) doc.moveDown(0.2).fillColor(MUTED).fontSize(11).font('Helvetica').text(model.candidate);
  doc.moveDown(0.5);
  doc.fillColor(model.colour).fontSize(34).font('Helvetica-Bold').text(`${model.score}/100`, { continued: true });
  doc.fontSize(13).font('Helvetica').text(`   ${model.verdict} match`);
  doc.moveDown(0.6);
  rule(doc, left, width);

  section(doc, 'Where the score came from');
  for (const [label, value, note] of model.components) {
    const percent = Math.round(value * 100);
    const y = doc.y;
    doc.fillColor(INK).fontSize(10.5).font('Helvetica-Bold').text(label, left, y, { width: width * 0.45 });
    doc.fillColor(INK).font('Helvetica-Bold').text(`${percent}%`, left + width * 0.45, y, { width: 40, align: 'right' });
    const barX = left + width * 0.55;
    const barW = width - width * 0.55;
    doc.roundedRect(barX, y + 2, barW, 7, 3.5).fill(LINE);
    if (percent > 0) doc.roundedRect(barX, y + 2, Math.max(3, (barW * percent) / 100), 7, 3.5).fill(ACCENT);
    doc.fillColor(MUTED).fontSize(9).font('Helvetica').text(note, left, y + 13, { width: width * 0.5 });
    doc.y = y + 26;
  }

  if (model.semantic.length) {
    section(doc, 'Counted even though you never used their words');
    doc.fillColor(MUTED).fontSize(9.5).font('Helvetica')
      .text('A keyword scanner gives these zero. This is the evidence they were matched against.', { width });
    doc.moveDown(0.4);
    for (const match of model.semantic.slice(0, 5)) {
      doc.fillColor(ACCENT).fontSize(10.5).font('Helvetica-Bold')
        .text(`${match.requirement}  `, { continued: true })
        .fillColor(MUTED).fontSize(9).font('Helvetica').text(`counted ${match.credit} of 1`);
      if (match.evidence) {
        doc.fillColor(INK).fontSize(9.5).font('Helvetica-Oblique')
          .text(`"${match.evidence}"`, { width: width - 14, indent: 12 });
      }
      doc.moveDown(0.35);
    }
  }

  if (model.absent.length) {
    section(doc, "What's missing");
    for (const gap of model.absent) {
      doc.fillColor(INK).fontSize(10).font('Helvetica-Bold').text(`• ${gap.requirement}`, { continued: true })
        .fillColor(MUTED).font('Helvetica')
        .text(`  — ${gap.severity === 'blocking' ? 'they call this essential' : 'they ask for it'}`);
    }
  }

  if (model.thin.length) {
    section(doc, 'Where your evidence is thin');
    doc.fillColor(MUTED).fontSize(9.5).font('Helvetica')
      .text('Listed on your resume, but nothing shows you using them.', { width });
    doc.moveDown(0.2);
    doc.fillColor(INK).fontSize(10).font('Helvetica').text(model.thin.map((g) => g.requirement).join(', '), { width });
  }

  if (model.courses.length) {
    section(doc, 'What to learn');
    for (const course of model.courses) {
      doc.fillColor(INK).fontSize(10.5).font('Helvetica-Bold').text(course.title, { width });
      doc.fillColor(MUTED).fontSize(9).font('Helvetica')
        .text(`${course.provider} — closes: ${course.closes_gap}`, { width });
      if (course.rationale) doc.fillColor(INK).fontSize(9.5).text(course.rationale, { width });
      doc.moveDown(0.35);
    }
  }

  if (model.improvements.length) {
    section(doc, 'How to improve your resume');
    for (const item of model.improvements) {
      doc.fillColor(INK).fontSize(10).font('Helvetica-Bold').text(item.target, { width });
      doc.fillColor(MUTED).fontSize(9.5).font('Helvetica').text(`Problem: ${item.issue}`, { width });
      doc.fillColor(INK).fontSize(9.5).text(`Try: ${item.suggested_rewrite}`, { width });
      doc.moveDown(0.4);
    }
  }

  if (model.atsIssues.length) {
    section(doc, 'Problems a resume scanner will hit');
    for (const issue of model.atsIssues) {
      doc.fillColor(INK).fontSize(9.5).font('Helvetica').text(`• ${issue}`, { width });
    }
  }

  doc.moveDown(0.8);
  rule(doc, left, width);
  doc.fillColor(MUTED).fontSize(8.5).font('Helvetica').text(footer(model), { width });

  doc.end();
  await done;
  return Buffer.concat(chunks);
}

function section(doc, title) {
  doc.moveDown(SECTION_GAP / 20);
  doc.fillColor(MUTED).fontSize(9).font('Helvetica-Bold').text(title.toUpperCase(), { characterSpacing: 0.6 });
  doc.moveDown(0.3);
}

function rule(doc, left, width) {
  doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor(LINE).lineWidth(1).stroke();
  doc.moveDown(0.5);
}

function footer(model) {
  const bits = ['Score computed deterministically from the parsed resume and job description.'];
  if (model.baseline !== undefined) bits.push(`A keyword-only scanner would score this ${model.baseline}.`);
  if (model.degraded) bits.push('Part of this report used offline fallback rules.');
  return bits.join(' ');
}

// --- DOCX --------------------------------------------------------------

/** @returns {Promise<Buffer|null>} */
export async function buildDocx(result) {
  let docx;
  try {
    docx = await import('docx');
  } catch (error) {
    console.warn('[export] docx unavailable:', error.message);
    return null;
  }
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = docx;
  const model = reportModel(result);

  const p = (text, options = {}) => new Paragraph({ children: [new TextRun({ text, ...options })], spacing: { after: 90 } });
  const heading = (text) => new Paragraph({ text, heading: HeadingLevel.HEADING_2, spacing: { before: 260, after: 110 } });

  const body = [
    new Paragraph({ text: model.title, heading: HeadingLevel.TITLE }),
    ...(model.candidate ? [p(model.candidate, { color: '6B7280' })] : []),
    new Paragraph({
      children: [
        new TextRun({ text: `${model.score}/100`, bold: true, size: 52, color: model.colour.replace('#', '') }),
        new TextRun({ text: `   ${model.verdict} match`, size: 24, color: '6B7280' }),
      ],
      spacing: { after: 220 },
      alignment: AlignmentType.LEFT,
    }),
    heading('Where the score came from'),
  ];

  for (const [label, value, note] of model.components) {
    const percent = Math.round(value * 100);
    const filled = Math.round(percent / 10);
    body.push(new Paragraph({
      children: [
        new TextRun({ text: `${label}: `, bold: true }),
        new TextRun({ text: `${percent}%  ` }),
        // Block glyphs give a bar in Word without needing a chart object.
        new TextRun({ text: '█'.repeat(filled) + '░'.repeat(10 - filled), color: '1C4F9C' }),
      ],
      spacing: { after: 40 },
    }));
    body.push(p(note, { italics: true, size: 18, color: '6B7280' }));
  }

  if (model.semantic.length) {
    body.push(heading('Counted even though you never used their words'));
    body.push(p('A keyword scanner gives these zero. This is the evidence they were matched against.',
      { italics: true, color: '6B7280', size: 19 }));
    for (const match of model.semantic.slice(0, 5)) {
      body.push(new Paragraph({
        children: [
          new TextRun({ text: match.requirement, bold: true, color: '1C4F9C' }),
          new TextRun({ text: `  counted ${match.credit} of 1`, color: '6B7280', size: 18 }),
        ],
        spacing: { after: 40 },
      }));
      if (match.evidence) body.push(p(`"${match.evidence}"`, { italics: true }));
    }
  }

  if (model.absent.length) {
    body.push(heading("What's missing"));
    for (const gap of model.absent) {
      body.push(new Paragraph({
        children: [
          new TextRun({ text: gap.requirement, bold: true }),
          new TextRun({ text: ` — ${gap.severity === 'blocking' ? 'they call this essential' : 'they ask for it'}`, color: '6B7280' }),
        ],
        bullet: { level: 0 },
        spacing: { after: 50 },
      }));
    }
  }

  if (model.thin.length) {
    body.push(heading('Where your evidence is thin'));
    body.push(p('Listed on your resume, but nothing shows you using them.', { color: '6B7280', size: 19 }));
    body.push(p(model.thin.map((g) => g.requirement).join(', ')));
  }

  if (model.courses.length) {
    body.push(heading('What to learn'));
    for (const course of model.courses) {
      body.push(p(course.title, { bold: true }));
      body.push(p(`${course.provider} — closes: ${course.closes_gap}`, { color: '6B7280', size: 19 }));
      if (course.rationale) body.push(p(course.rationale));
    }
  }

  if (model.improvements.length) {
    body.push(heading('How to improve your resume'));
    for (const item of model.improvements) {
      body.push(p(item.target, { bold: true }));
      body.push(p(`Problem: ${item.issue}`, { color: '6B7280' }));
      body.push(p(`Try: ${item.suggested_rewrite}`));
    }
  }

  if (model.atsIssues.length) {
    body.push(heading('Problems a resume scanner will hit'));
    for (const issue of model.atsIssues) {
      body.push(new Paragraph({ children: [new TextRun({ text: issue })], bullet: { level: 0 }, spacing: { after: 50 } }));
    }
  }

  body.push(p(footer(model), { size: 17, color: '6B7280', italics: true }));

  const document = new Document({ sections: [{ children: body }] });
  return Packer.toBuffer(document);
}
