import { useState } from 'react';
import ScoreGauge, { SubScores } from './ScoreGauge.jsx';
import { downloadReport } from '../api.js';

const SEVERITY_ORDER = { blocking: 0, important: 1, minor: 2 };

function DownloadBar({ result }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const grab = async (format) => {
    setBusy(format);
    setError('');
    try {
      await downloadReport(result, format);
    } catch (problem) {
      setError(problem.message);
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="downloads">
      <span className="muted">Save this report:</span>
      <button className="ghost" onClick={() => grab('pdf')} disabled={Boolean(busy)}>
        {busy === 'pdf' ? 'Building…' : 'PDF'}
      </button>
      <button className="ghost" onClick={() => grab('docx')} disabled={Boolean(busy)}>
        {busy === 'docx' ? 'Building…' : 'Word (.docx)'}
      </button>
      {error && <span className="warn-inline">{error}</span>}
    </div>
  );
}

export default function MatchPanel({ result }) {
  if (!result) return null;
  const semantic = result.matched.filter((m) => m.match_type !== 'exact');
  const unevidenced = result.matched.filter((m) => m.match_type === 'exact' && m.evidenced === false);
  const gaps = [...result.gaps].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  return (
    <div className="panel">
      <DownloadBar result={result} />

      <header className="panel-head">
        <div>
          <h2>{result._meta?.role_title || 'Fit report'}</h2>
          <p className="muted">
            {result._meta?.candidate_name ? `${result._meta.candidate_name} · ` : ''}
            {result.matched.length} requirements matched, {result.gaps.length} gaps
          </p>
        </div>
        <ScoreGauge score={result.overall_score} verdict={result.verdict} />
      </header>

      {result._meta?.degraded && (
        <p className="warn">
          Part of this ran on fallback rules because the model was unavailable. Treat it as low confidence.
        </p>
      )}

      <SubScores sub={result.sub_scores} />

      {semantic.length > 0 && (
        <section>
          <h3>Credited without the exact keyword</h3>
          <p className="muted">A keyword checker scores these zero. Here is the sentence we matched against.</p>
          {semantic.map((m) => (
            <div className="evidence" key={m.requirement}>
              <div className="evidence-head">
                <strong>{m.requirement}</strong>
                <span className={`chip chip-${m.match_type}`}>{m.match_type} · {m.credit}</span>
                <span className="chip chip-source">{m.resolved_by === 'rule' ? 'no model call' : 'model'}</span>
              </div>
              <blockquote>{m.evidence}</blockquote>
            </div>
          ))}
        </section>
      )}

      {unevidenced.length > 0 && (
        <section>
          <h3>Claimed but never shown in use</h3>
          <p className="muted">Listed in a skills section with no supporting sentence — credited 0.7, not 1.0.</p>
          <p>{unevidenced.map((m) => m.requirement).join(', ')}</p>
        </section>
      )}

      {gaps.length > 0 && (
        <section>
          <h3>Gaps</h3>
          <ul className="gaps">
            {gaps.map((gap) => (
              <li key={`${gap.requirement}-${gap.bucket}`} className={`gap gap-${gap.severity}`}>
                <span className="gap-sev">{gap.severity}</span>
                <div>
                  <strong>{gap.requirement}</strong>
                  {gap.credit > 0 && <span className="muted"> · partial credit {gap.credit}</span>}
                  <p className="muted">{gap.why_it_matters}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {result.suggested_courses?.length > 0 && (
        <section>
          <h3>Courses that close them</h3>
          <p className="muted">Selected from a seeded catalogue of {result._meta?.catalogue_size || 42}. Nothing here is invented.</p>
          <div className="cards">
            {result.suggested_courses.map((course) => (
              <div className="card" key={`${course.course_id}-${course.closes_gap}`}>
                <div className="card-head">
                  <strong>{course.title}</strong>
                  <code>{course.course_id}</code>
                </div>
                <p className="muted">{course.provider}</p>
                <p>{course.rationale}</p>
                <p className="closes">closes: {course.closes_gap}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {result.resume_improvements?.length > 0 && (
        <section>
          <h3>Rewrite these bullets</h3>
          {result.resume_improvements.map((item, i) => (
            <div className="rewrite" key={i}>
              <div className="rewrite-target">{item.target}</div>
              <p className="muted">{item.issue}</p>
              <p className="rewrite-text">{item.suggested_rewrite}</p>
            </div>
          ))}
        </section>
      )}

      {result.ats_issues?.length > 0 && (
        <section>
          <h3>ATS hygiene</h3>
          <ul className="ats">{result.ats_issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>
        </section>
      )}

      {result._meta && (
        <footer className="meta">
          <span>{result._meta.resolved_by_rule} requirement(s) resolved by rules, {result._meta.resolved_by_model} by the model</span>
          <span>keyword-only baseline on this pair: {result._meta.keyword_baseline?.overall_score}</span>
          <span>parse confidence: resume {result._meta.parse_confidence?.resume}, JD {result._meta.parse_confidence?.jd}</span>
        </footer>
      )}
    </div>
  );
}
