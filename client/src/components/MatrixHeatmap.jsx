/** Colour is a straight lightness ramp on one hue — no red/green traps. */
function cellStyle(score) {
  const t = Math.max(0, Math.min(100, score)) / 100;
  const lightness = 96 - t * 46;
  return { background: `hsl(211 60% ${lightness}%)`, color: t > 0.55 ? '#fff' : '#1a1a1a' };
}

export default function MatrixHeatmap({ data }) {
  if (!data) return null;
  const { matrix, resumes, jds, best_per_jd: bestPerJd, summary, stats } = data;

  return (
    <div className="panel">
      <h2>Which resume for which job</h2>
      <p className="lede">{summary}</p>

      <div className="matrix-scroll">
        <table className="matrix">
          <thead>
            <tr>
              <th />
              {jds.map((jd) => <th key={jd.id}>{jd.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {matrix.map((row, i) => (
              <tr key={resumes[i].id}>
                <th scope="row">{resumes[i].label}</th>
                {row.map((score, j) => {
                  const isWinner = bestPerJd[j].resume_index === i;
                  return (
                    <td key={jds[j].id} className={isWinner ? 'winner' : ''} style={cellStyle(score)}>
                      {score}
                      {isWinner && <span className="winner-tag">best</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="stats">
        <div>
          <strong>{stats.model_calls}</strong>
          <span>model calls for {resumes.length} resumes × {jds.length} jobs</span>
        </div>
        <div>
          <strong>{stats.naive_calls_would_be}</strong>
          <span>calls a naive one-per-pair tool would make</span>
        </div>
        <div>
          <strong>{stats.cache_hits}</strong>
          <span>parses served from cache</span>
        </div>
        <div>
          <strong>{stats.elapsed_ms}ms</strong>
          <span>total</span>
        </div>
      </div>
      <p className="muted">
        We parse each document once and match from the structured objects, so cost is M+N, not M×N.
        At 10 resumes × 10 jobs that is 20 calls instead of 100.
      </p>
    </div>
  );
}
