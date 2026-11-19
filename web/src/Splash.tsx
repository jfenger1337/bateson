import { useCallback, useEffect, useRef, useState } from 'react';
import { getStroke } from 'perfect-freehand';
import { reduced } from '@/lib/motion';

// Bateson's mark, drawn on launch with a drying felt-tip: the two rings, left to right, then the dot, lower and a
// little bigger, scribbled in. Each ring is a slightly lopsided loop that runs a little past where it began. A narrow
// solid core carries the line; thin strands either side of it wander a little and break where the felt skips, more
// often towards the edges, so the grit runs along the stroke the way a dry marker streaks. perfect-freehand turns
// each path into the outline of an ink stroke, and every frame draws a little more of them. The skips come from a
// fixed seed: the same drawing every launch.

const SEEN = 'bateson:splash';
const FADE_MS = 450; // --dur-arrive
const REST_MS = 750; // the mark stays a moment before the app comes up
const LONGEST_MS = 4000; // never in the way for longer, whatever happens

// Once per launch: the Mac app's web view keeps sessionStorage across reloads, so a new build does not replay it.
function shouldPlay() {
  if (reduced()) return false;
  try { return !sessionStorage.getItem(SEEN); } catch { return true; }
}

// mulberry32: small, seeded, good enough for a hand.
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Where the pen is at `t` (0 to 1) along a mark, and how far out from the middle of the line `off` sits, for the
// strands. The logo's coordinates, ten times over (site/index.html's mark).
type Path = (t: number, off: number) => [number, number];

// From the top left, anticlockwise as most right hands go, a slow wobble, drifting inward, a touch more than one turn.
const ring = (cx: number, cy: number, r: number, wob: number): Path => (t, off) => {
  const a = -2.2 - Math.PI * 2 * 1.04 * t;
  const d = off + r * (1 - 0.07 * t) + r * 0.06 * Math.sin(a * 2 + wob) + r * 0.03 * Math.sin(a * 3 + 2.1);
  return [cx + d * Math.cos(a), cy + d * Math.sin(a)];
};

// Once round the edge, then spiralling in until it is filled.
const dot = (cx: number, cy: number, r: number): Path => (t, off) => {
  const a = -2.2 - Math.PI * 2 * 3.2 * t;
  const d = Math.max(0, off + r * Math.min(1, 1.35 * (1 - t)) + r * 0.05 * Math.sin(a * 2 + 0.8));
  return [cx + d * Math.cos(a), cy + d * Math.sin(a)];
};

type Part = { from: number; pts: number[][]; opts: Parameters<typeof getStroke>[1] };
type Stroke = { at: number; ms: number; n: number; parts: Part[] };

function marker(seed: number, path: Path, n: number, strands = 12, spread = 8): Part[] {
  const rand = rng(seed);
  const line = (off: (t: number) => number) => Array.from({ length: n + 1 }, (_, i) => [...path(i / n, off(i / n)), 0.5]);
  const parts: Part[] = [{ from: 0, pts: line(() => 0), opts: { size: 6, thinning: 0, smoothing: 0.5, streamline: 0.4, simulatePressure: false } }];
  for (let k = 0; k < strands; k++) {
    const o = -spread + (2 * spread * k) / (strands - 1), edge = Math.abs(o) / spread;
    const ph = rand() * 6.3, f = 2 + rand() * 5;
    const pts = line((t) => o + 0.7 * Math.sin(t * f * 6.28 + ph));
    const skip = 0.08 + 0.45 * edge * edge;
    for (let i = Math.floor(rand() * 8); i < pts.length;) {
      const run = 4 + Math.floor(rand() * 22), gap = rand() < skip ? 2 + Math.floor(rand() * 12) : 0;
      parts.push({
        from: i, pts: pts.slice(i, i + run),
        opts: { size: 1.4 + rand() * 1.4 * (1 - edge * 0.5), thinning: 0.5, smoothing: 0.5, streamline: 0.3, simulatePressure: false, start: { taper: 3 }, end: { taper: 3 } },
      });
      i += run + gap;
    }
  }
  return parts;
}

const stroke = (at: number, ms: number, n: number, seed: number, path: Path): Stroke => ({ at, ms, n, parts: marker(seed, path, n) });

// The pen lifts for a beat between marks.
const STROKES = [
  stroke(0, 360, 64, 5, ring(80, 160, 31, 0.8)),
  stroke(460, 360, 64, 11, ring(190, 160, 31, 2.4)),
  stroke(920, 600, 130, 17, dot(300, 210, 31)),
];
const DRAW_MS = Math.max(...STROKES.map((s) => s.at + s.ms));

// perfect-freehand's outline as an SVG path (from its README).
function outline(pts: number[][]) {
  if (pts.length < 4) return '';
  const mid = (a: number[], b: number[]) => `${((a[0] + b[0]) / 2).toFixed(2)},${((a[1] + b[1]) / 2).toFixed(2)}`;
  let d = `M${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)} Q${pts[1][0].toFixed(2)},${pts[1][1].toFixed(2)} ${mid(pts[1], pts[2])} T`;
  for (let i = 2; i < pts.length - 1; i++) d += `${mid(pts[i], pts[i + 1])} `;
  return d + 'Z';
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export function Splash() {
  const [phase, setPhase] = useState<'on' | 'leaving' | 'gone'>(() => (shouldPlay() ? 'on' : 'gone'));
  const paths = useRef<(SVGPathElement | null)[]>([]);
  const leave = useCallback(() => setPhase((p) => (p === 'on' ? 'leaving' : p)), []);
  const showing = phase !== 'gone';

  useEffect(() => {
    try { sessionStorage.setItem(SEEN, '1'); } catch { /* private window: it just plays again */ }
  }, []);

  // The drawing: the pen a little further along each frame, quick through each mark, slow at either end of it.
  useEffect(() => {
    if (!showing) return;
    let raf = 0, rest = 0;
    const t0 = performance.now();
    const frame = (now: number) => {
      const ms = now - t0;
      let i = 0;
      for (const s of STROKES) {
        const t = Math.min(Math.max((ms - s.at) / s.ms, 0), 1);
        const n = Math.round(easeInOut(t) * (s.n + 1));
        for (const p of s.parts) {
          const m = Math.min(p.pts.length, n - p.from);
          paths.current[i++]?.setAttribute('d', m >= 2 ? outline(getStroke(p.pts.slice(0, m), { ...p.opts, last: m === p.pts.length })) : '');
        }
      }
      if (ms < DRAW_MS) raf = requestAnimationFrame(frame);
      else rest = window.setTimeout(leave, REST_MS);
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); clearTimeout(rest); };
  }, [showing, leave]);

  useEffect(() => {
    if (phase === 'on') {
      const t = window.setTimeout(leave, LONGEST_MS);
      window.addEventListener('keydown', leave);
      return () => { clearTimeout(t); window.removeEventListener('keydown', leave); };
    }
    if (phase === 'leaving') {
      const t = window.setTimeout(() => setPhase('gone'), FADE_MS);
      return () => clearTimeout(t);
    }
  }, [phase, leave]);

  if (!showing) return null;
  return (
    <div className={`splash${phase === 'leaving' ? ' splash-leaving' : ''}`} onClick={leave} role="img" aria-label="bateson">
      <svg className="splash-mark" viewBox="30 110 320 150" aria-hidden>
        {STROKES.flatMap((s) => s.parts).map((_, i) => <path key={i} ref={(el) => { paths.current[i] = el; }} />)}
      </svg>
    </div>
  );
}
