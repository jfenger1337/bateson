// Bateson's one notation for status: an open ring is pending, a dashed ring is automatic or conditional,
// a filled dot is decided. A `letter` sits inside an open or dashed ring: the key that picks what the ring marks.
export function Ring({ kind, size = 16, pulse, letter }: { kind: 'open' | 'dashed' | 'dot'; size?: number; pulse?: boolean; letter?: string }) {
  const r = size / 2 - 1.25;
  return (
    <svg className={`ring ring-${kind}${pulse ? ' ring-pulse' : ''}`} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      {kind === 'dot' ? (
        <>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth="1.5" />
          <circle cx={size / 2} cy={size / 2} r={r * 0.5} fill="currentColor" />
        </>
      ) : (
        <>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray={kind === 'dashed' ? '2.4 2.2' : undefined} />
          {letter && <text className="ring-letter" x="50%" y="50%" textAnchor="middle" dominantBaseline="central">{letter}</text>}
        </>
      )}
    </svg>
  );
}
