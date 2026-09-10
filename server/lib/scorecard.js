// Draws the fit report as an SVG card. Pure string building — no canvas, no
// dependency, no I/O — so it is testable and it cannot fail at demo time.
// telegram.js rasterises this to PNG when a renderer is available; the web
// client drops the same markup straight into the page.

const PALETTE = {
  strong: '#1a7f4b',
  moderate: '#b26a00',
  weak: '#b3261e',
  ink: '#16191d',
  muted: '#6b7280',
  line: '#e5e7eb',
  panel: '#ffffff',
  bg: '#f7f8fa',
  accent: '#1c4f9c',
};

/** SVG has five characters that must never appear raw in text content. */
const esc = (text) => String(text ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const clip = (text, max) => {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

/** A semicircular gauge, drawn as one arc with a dash offset. */
function gauge(score, colour, cx, cy, radius = 62) {
  const circumference = Math.PI * radius;
  const filled = (Math.max(0, Math.min(100, score)) / 100) * circumference;
  const path = `M ${cx - radius} ${cy} A ${radius} ${radius} 0 0 1 ${cx + radius} ${cy}`;
  return `
    <path d="${path}" fill="none" stroke="${PALETTE.line}" stroke-width="14" stroke-linecap="round"/>
    <path d="${path}" fill="none" stroke="${colour}" stroke-width="14" stroke-linecap="round"
          stroke-dasharray="${filled.toFixed(2)} ${circumference.toFixed(2)}"/>
    <text x="${cx}" y="${cy - 8}" text-anchor="middle" font-size="40" font-weight="700" fill="${colour}">${score}</text>
    <text x="${cx}" y="${cy + 14}" text-anchor="middle" font-size="13" fill="${PALETTE.muted}">out of 100</text>`;
}

/** One labelled progress bar. */
function bar(label, value, explanation, x, y, width) {
  const percent = Math.round(value * 100);
  const filled = Math.max(2, (width * percent) / 100);
  return `
    <text x="${x}" y="${y}" font-size="13" font-weight="600" fill="${PALETTE.ink}">${esc(label)}</text>
    <text x="${x + width}" y="${y}" font-size="13" font-weight="700" text-anchor="end" fill="${PALETTE.ink}">${percent}%</text>
    <rect x="${x}" y="${y + 7}" width="${width}" height="9" rx="4.5" fill="${PALETTE.line}"/>
    <rect x="${x}" y="${y + 7}" width="${filled.toFixed(1)}" height="9" rx="4.5" fill="${PALETTE.accent}"/>
    <text x="${x}" y="${y + 30}" font-size="11.5" fill="${PALETTE.muted}">${esc(explanation)}</text>`;
}

/**
 * @param {object} result a MatchResult (with _meta)
 * @returns {string} standalone SVG
 */
export function scorecardSvg(result) {
  const meta = result._meta || {};
  const colour = PALETTE[result.verdict] || PALETTE.muted;
  const months = meta.experience || {};
  const W = 720;
  const pad = 28;
  const parts = [];

  // Header
  parts.push(`
    <rect x="0" y="0" width="${W}" height="118" fill="${PALETTE.panel}"/>
    <rect x="0" y="0" width="6" height="118" fill="${colour}"/>
    <text x="${pad}" y="42" font-size="21" font-weight="700" fill="${PALETTE.ink}">${esc(clip(meta.role_title || 'Fit report', 42))}</text>
    <text x="${pad}" y="66" font-size="13.5" fill="${PALETTE.muted}">${esc(clip(meta.candidate_name || 'Your resume', 40))}</text>
    <rect x="${pad}" y="80" width="${verdictWidth(result.verdict)}" height="24" rx="12" fill="${colour}"/>
    <text x="${pad + 13}" y="96" font-size="12.5" font-weight="700" fill="#fff">${esc(result.verdict.toUpperCase())} MATCH</text>
    ${gauge(result.overall_score, colour, W - 110, 92)}`);

  // Score breakdown
  let y = 160;
  parts.push(`<text x="${pad}" y="${y}" font-size="12" font-weight="700" letter-spacing="1" fill="${PALETTE.muted}">WHERE THE SCORE CAME FROM</text>`);
  y += 26;
  const barWidth = (W - pad * 2 - 40) / 2;
  const rows = [
    ['Skills they require', result.sub_scores.must_have_coverage, 'half the score'],
    ['Skills they prefer', result.sub_scores.nice_to_have_coverage, 'the bonus list'],
    ['Experience', result.sub_scores.experience_fit, months.required_months
      ? `${readable(months.candidate_months)} of ${readable(months.required_months)}` : 'no set amount asked'],
    ['Resume formatting', result.sub_scores.ats_hygiene, 'machine readability'],
  ];
  rows.forEach(([label, value, note], i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    parts.push(bar(label, value, note, pad + col * (barWidth + 40), y + row * 58, barWidth));
  });
  y += 128;

  // The differentiator
  const semantic = result.matched.filter((m) => m.match_type !== 'exact').slice(0, 2);
  if (semantic.length) {
    parts.push(`<text x="${pad}" y="${y}" font-size="12" font-weight="700" letter-spacing="1" fill="${PALETTE.muted}">COUNTED WITHOUT THEIR EXACT WORDS</text>`);
    y += 12;
    for (const match of semantic) {
      const height = 54;
      parts.push(`
        <rect x="${pad}" y="${y}" width="${W - pad * 2}" height="${height}" rx="6" fill="#f2f6fc"/>
        <rect x="${pad}" y="${y}" width="3.5" height="${height}" rx="2" fill="${PALETTE.accent}"/>
        <text x="${pad + 14}" y="${y + 21}" font-size="13" font-weight="700" fill="${PALETTE.accent}">${esc(clip(match.requirement, 34))}</text>
        <text x="${W - pad - 12}" y="${y + 21}" font-size="11.5" text-anchor="end" fill="${PALETTE.muted}">counted ${match.credit}</text>
        <text x="${pad + 14}" y="${y + 41}" font-size="11.5" font-style="italic" fill="${PALETTE.ink}">${esc(clip(match.evidence, 82))}</text>`);
      y += height + 9;
    }
    y += 12;
  }

  // Missing / thin
  const absent = result.gaps.filter((g) => g.credit === 0 && g.severity !== 'minor').slice(0, 4);
  if (absent.length) {
    parts.push(`<text x="${pad}" y="${y}" font-size="12" font-weight="700" letter-spacing="1" fill="${PALETTE.muted}">WHAT'S MISSING</text>`);
    y += 22;
    absent.forEach((gap) => {
      const tone = gap.severity === 'blocking' ? PALETTE.weak : PALETTE.moderate;
      parts.push(`
        <circle cx="${pad + 5}" cy="${y - 4}" r="4" fill="${tone}"/>
        <text x="${pad + 18}" y="${y}" font-size="13" fill="${PALETTE.ink}">${esc(clip(gap.requirement, 30))}</text>
        <text x="${pad + 210}" y="${y}" font-size="11.5" fill="${PALETTE.muted}">${gap.severity === 'blocking' ? 'they call this essential' : 'they ask for it'}</text>`);
      y += 22;
    });
    y += 10;
  }

  // Courses
  const courses = (result.suggested_courses || []).slice(0, 2);
  if (courses.length) {
    parts.push(`<text x="${pad}" y="${y}" font-size="12" font-weight="700" letter-spacing="1" fill="${PALETTE.muted}">WHAT TO LEARN</text>`);
    y += 20;
    courses.forEach((course) => {
      parts.push(`
        <rect x="${pad}" y="${y}" width="${W - pad * 2}" height="42" rx="6" fill="${PALETTE.panel}" stroke="${PALETTE.line}"/>
        <text x="${pad + 12}" y="${y + 18}" font-size="12.5" font-weight="600" fill="${PALETTE.ink}">${esc(clip(course.title, 46))}</text>
        <text x="${pad + 12}" y="${y + 33}" font-size="11" fill="${PALETTE.muted}">${esc(clip(course.provider, 40))}</text>
        <text x="${W - pad - 12}" y="${y + 26}" font-size="11" text-anchor="end" fill="${PALETTE.accent}">closes: ${esc(clip(course.closes_gap, 34))}</text>`);
      y += 50;
    });
    y += 4;
  }

  // Footer: the engineering claim, on the artefact itself
  const H = y + 46;
  parts.push(`
    <line x1="${pad}" y1="${H - 34}" x2="${W - pad}" y2="${H - 34}" stroke="${PALETTE.line}"/>
    <text x="${pad}" y="${H - 14}" font-size="10.5" fill="${PALETTE.muted}">${esc(footerLine(meta))}</text>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="DejaVu Sans, Helvetica, Arial, sans-serif">
  <rect width="${W}" height="${H}" fill="${PALETTE.bg}"/>
  <rect x="0" y="0" width="${W}" height="118" fill="${PALETTE.panel}"/>
  ${parts.join('\n')}
</svg>`;
}

function footerLine(meta) {
  const bits = [];
  if (meta.resolved_by_rule || meta.resolved_by_model) {
    bits.push(`${meta.resolved_by_rule} matched by rules, ${meta.resolved_by_model} by AI`);
  }
  if (meta.keyword_baseline) bits.push(`a keyword-only scanner would score this ${meta.keyword_baseline.overall_score}`);
  if (meta.degraded) bits.push('AI unavailable — offline rules used');
  return bits.join('  ·  ') || 'Scored deterministically from the parsed resume and job description.';
}

// Sized from the text, not guessed: a fixed width clips "MODERATE MATCH".
const verdictWidth = (verdict) => Math.round((verdict.length + 6) * 9.4 + 28);

function readable(months) {
  if (!months) return 'none';
  if (months < 12) return `${months} mo`;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return rest ? `${years}y ${rest}m` : `${years} yr`;
}


/**
 * The matrix as a heatmap image. One hue, lightness ramp — no red/green
 * traps — with the winning cell per job outlined.
 */
export function matrixSvg({ matrix, resumes, jds, stats }) {
  const pad = 28;
  const labelW = 150;
  const cellW = 118;
  const cellH = 54;
  const headerH = 96;
  const W = pad * 2 + labelW + cellW * jds.length;
  const H = headerH + cellH * resumes.length + 96;
  const parts = [];

  parts.push(`<text x="${pad}" y="42" font-size="20" font-weight="700" fill="${PALETTE.ink}">Which resume for which job</text>`);
  parts.push(`<text x="${pad}" y="64" font-size="12.5" fill="${PALETTE.muted}">Higher is a better fit. The outlined cell wins that job.</text>`);

  jds.forEach((jd, j) => {
    const x = pad + labelW + j * cellW;
    parts.push(`<text x="${x + cellW / 2}" y="${headerH - 10}" text-anchor="middle" font-size="12" font-weight="600" fill="${PALETTE.ink}">${esc(clip(jd, 15))}</text>`);
  });

  matrix.forEach((row, i) => {
    const y = headerH + i * cellH;
    parts.push(`<text x="${pad}" y="${y + cellH / 2 + 5}" font-size="13" font-weight="600" fill="${PALETTE.ink}">${esc(clip(resumes[i], 20))}</text>`);
    row.forEach((score, j) => {
      const x = pad + labelW + j * cellW;
      const column = matrix.map((r) => r[j]);
      const isWinner = score === Math.max(...column);
      const lightness = 96 - (Math.max(0, Math.min(100, score)) / 100) * 46;
      const textColour = score > 55 ? '#ffffff' : PALETTE.ink;
      parts.push(`
        <rect x="${x + 4}" y="${y + 4}" width="${cellW - 8}" height="${cellH - 8}" rx="6"
              fill="hsl(211 60% ${lightness.toFixed(1)}%)"
              ${isWinner ? `stroke="${PALETTE.strong}" stroke-width="2.5"` : ''}/>
        <text x="${x + cellW / 2}" y="${y + cellH / 2 + 6}" text-anchor="middle" font-size="17" font-weight="700" fill="${textColour}">${score}</text>`);
    });
  });

  const y = headerH + matrix.length * cellH + 34;
  parts.push(`<line x1="${pad}" y1="${y - 16}" x2="${W - pad}" y2="${y - 16}" stroke="${PALETTE.line}"/>`);
  parts.push(`<text x="${pad}" y="${y}" font-size="12" fill="${PALETTE.ink}">${esc(
    `${stats.model_calls} AI call${stats.model_calls === 1 ? '' : 's'} for ${resumes.length} resumes x ${jds.length} jobs — a tool scoring every pair separately would make ${resumes.length * jds.length}.`)}</text>`);
  parts.push(`<text x="${pad}" y="${y + 20}" font-size="11.5" fill="${PALETTE.muted}">Each document is read once, then compared from its summary.</text>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="DejaVu Sans, Helvetica, Arial, sans-serif">
  <rect width="${W}" height="${H}" fill="${PALETTE.bg}"/>
  <rect x="0" y="0" width="${W}" height="${headerH - 26}" fill="${PALETTE.panel}"/>
  ${parts.join('\n')}
</svg>`;
}
