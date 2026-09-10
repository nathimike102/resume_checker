const VERDICT_COLOR = { strong: '#1a7f4b', moderate: '#b26a00', weak: '#b3261e' };

/** A semicircle, drawn with one SVG arc. No chart library for one number. */
export default function ScoreGauge({ score, verdict }) {
  const radius = 80;
  const circumference = Math.PI * radius;
  const filled = (Math.max(0, Math.min(100, score)) / 100) * circumference;
  const color = VERDICT_COLOR[verdict] || '#555';

  return (
    <div className="gauge">
      <svg viewBox="0 0 200 110" width="200" height="110" role="img" aria-label={`${score} out of 100, ${verdict} fit`}>
        <path d="M 20 100 A 80 80 0 0 1 180 100" fill="none" stroke="#e6e6e6" strokeWidth="16" strokeLinecap="round" />
        <path
          d="M 20 100 A 80 80 0 0 1 180 100"
          fill="none"
          stroke={color}
          strokeWidth="16"
          strokeLinecap="round"
          strokeDasharray={`${filled} ${circumference}`}
        />
        <text x="100" y="88" textAnchor="middle" className="gauge-score" fill={color}>{score}</text>
      </svg>
      <div className="gauge-label" style={{ color }}>{verdict} fit</div>
    </div>
  );
}

export function SubScores({ sub }) {
  const rows = [
    ['Must-have coverage', sub.must_have_coverage, '50%'],
    ['Nice-to-have coverage', sub.nice_to_have_coverage, '20%'],
    ['Experience fit', sub.experience_fit, '20%'],
    ['ATS hygiene', sub.ats_hygiene, '10%'],
  ];
  return (
    <table className="subscores">
      <thead>
        <tr><th>Component</th><th>Score</th><th>Weight</th></tr>
      </thead>
      <tbody>
        {rows.map(([label, value, weight]) => (
          <tr key={label}>
            <td>{label}</td>
            <td>
              <div className="bar"><div className="bar-fill" style={{ width: `${Math.round(value * 100)}%` }} /></div>
              <span className="bar-value">{Math.round(value * 100)}%</span>
            </td>
            <td className="weight">{weight}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
