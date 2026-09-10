import { useEffect, useState } from 'react';
import Chat from './components/Chat.jsx';
import MatchPanel from './components/MatchPanel.jsx';
import MatrixHeatmap from './components/MatrixHeatmap.jsx';
import { health, matrix as runMatrix, runEval } from './api.js';

const blank = () => ({ label: '', text: '' });

export default function App() {
  const [tab, setTab] = useState('chat');
  const [result, setResult] = useState(null);
  const [status, setStatus] = useState(null);
  const [matrixData, setMatrixData] = useState(null);
  const [evalData, setEvalData] = useState(null);
  const [resumes, setResumes] = useState([blank(), blank()]);
  const [jds, setJds] = useState([blank(), blank()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { health().then(setStatus).catch(() => setStatus(null)); }, []);

  const edit = (setter) => (index, field, value) =>
    setter((list) => list.map((item, i) => (i === index ? { ...item, [field]: value } : item)));

  async function submitMatrix() {
    setBusy(true); setError('');
    try {
      setMatrixData(await runMatrix(
        resumes.filter((r) => r.text.trim()),
        jds.filter((j) => j.text.trim()),
      ));
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function submitEval() {
    setBusy(true); setError('');
    try { setEvalData(await runEval()); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="app">
      <header className="top">
        <div>
          <h1>Resume ↔ JD Fit</h1>
          <p className="muted">Which resume to send where, and what to learn before the next one.</p>
        </div>
        {status && (
          <div className="status">
            <span className={`dot ${status.mode.startsWith('stub') ? 'dot-stub' : 'dot-live'}`} />
            {status.mode} · {status.cache.backend} cache · telegram {status.channels.telegram ? 'on' : 'off'} · whatsapp off
          </div>
        )}
      </header>

      <nav className="tabs">
        {['chat', 'matrix', 'eval'].map((name) => (
          <button key={name} className={tab === name ? 'tab tab-on' : 'tab'} onClick={() => setTab(name)}>
            {name === 'chat' ? 'Chat' : name === 'matrix' ? 'Matrix' : 'Evaluation'}
          </button>
        ))}
      </nav>

      {error && <p className="warn">{error}</p>}

      {tab === 'chat' && (
        <div className="split">
          <Chat onResult={setResult} />
          {result ? <MatchPanel result={result} /> : <div className="panel muted">The fit report appears here.</div>}
        </div>
      )}

      {tab === 'matrix' && (
        <div className="panel">
          <h2>Compare several resumes against several jobs</h2>
          <p className="muted">Capped at 5 × 5, deliberately. Paste text into the boxes you need.</p>
          <div className="grid-inputs">
            <div>
              <h3>Resumes</h3>
              {resumes.map((item, i) => (
                <div className="input-row" key={i}>
                  <input placeholder={`Label (e.g. Full-stack version)`} value={item.label}
                    onChange={(e) => edit(setResumes)(i, 'label', e.target.value)} />
                  <textarea rows={4} placeholder="Paste resume text…" value={item.text}
                    onChange={(e) => edit(setResumes)(i, 'text', e.target.value)} />
                </div>
              ))}
              {resumes.length < 5 && <button className="ghost" onClick={() => setResumes([...resumes, blank()])}>+ resume</button>}
            </div>
            <div>
              <h3>Job descriptions</h3>
              {jds.map((item, i) => (
                <div className="input-row" key={i}>
                  <input placeholder="Label (e.g. Backend Engineer)" value={item.label}
                    onChange={(e) => edit(setJds)(i, 'label', e.target.value)} />
                  <textarea rows={4} placeholder="Paste job description text…" value={item.text}
                    onChange={(e) => edit(setJds)(i, 'text', e.target.value)} />
                </div>
              ))}
              {jds.length < 5 && <button className="ghost" onClick={() => setJds([...jds, blank()])}>+ job</button>}
            </div>
          </div>
          <button onClick={submitMatrix} disabled={busy}>{busy ? 'Scoring…' : 'Run the grid'}</button>
          {matrixData && <MatrixHeatmap data={matrixData} />}
        </div>
      )}

      {tab === 'eval' && (
        <div className="panel">
          <h2>Does it work?</h2>
          <p className="muted">15 hand-labelled pairs, scored against a pure keyword-overlap baseline on the same pairs.</p>
          <button onClick={submitEval} disabled={busy}>{busy ? 'Running…' : 'Run evaluation'}</button>
          {evalData && (
            <>
              <div className="stats">
                <div><strong>{evalData.ours.verdict_accuracy}%</strong><span>our verdict accuracy</span></div>
                <div><strong>{evalData.keyword_baseline.verdict_accuracy}%</strong><span>keyword baseline</span></div>
                <div><strong>{evalData.majority_class_baseline.verdict_accuracy}%</strong><span>always-guess-commonest</span></div>
                <div><strong>{evalData.random_baseline.verdict_accuracy}%</strong><span>random over 3 classes</span></div>
                <div><strong>{evalData.ours.ranking_agreement}%</strong><span>our pairwise ranking agreement</span></div>
                <div><strong>{evalData.keyword_baseline.ranking_agreement}%</strong><span>baseline ranking agreement</span></div>
                <div><strong>{evalData.parse_validity_rate}%</strong><span>parse validity</span></div>
              </div>
              <p className="warn">{evalData.caveat}</p>
              <div className="matrix-scroll">
                <table className="matrix eval-table">
                  <thead>
                    <tr><th>Resume</th><th>Job</th><th>Labelled</th><th>Ours</th><th>Score</th><th>Baseline</th></tr>
                  </thead>
                  <tbody>
                    {evalData.rows.map((row, i) => (
                      <tr key={i} className={row.correct ? '' : 'miss'}>
                        <td>{row.resume_label}</td><td>{row.jd_label}</td>
                        <td>{row.expected}</td><td>{row.got}</td>
                        <td>{row.score}</td><td>{row.baseline_score}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
