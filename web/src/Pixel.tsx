import { useEffect, useState } from 'react';
import { PIXELS, type PixelName } from './pixels';
import { reduced } from '@/lib/motion';

// A pixel icon from pixels.ts, at a whole multiple of its 24-pixel grid (scale 1 is 24px, 2 is 48px), so every
// pixel lands on whole screen pixels and stays sharp. It draws in currentColor, with the fainter pixels in --faint-3,
// so it takes either theme. It plays its frames, once or in a loop, unless `still` is set or motion is
// reduced (the Motion setting, or the system's under System): then it shows its resting frame.

const N = 24;

// A frame's grid as path data, one per tone: each run of a character along a row becomes a one-pixel-high rectangle.
type Paths = { ink: string; faint: string };
const cache = new Map<string, Paths>();
function paths(frame: string): Paths {
  const hit = cache.get(frame);
  if (hit) return hit;
  const out: Paths = { ink: '', faint: '' };
  const key = { '#': 'ink', '*': 'faint' } as const;
  frame.trim().split('\n').forEach((row, y) => {
    for (let x = 0; x < N;) {
      const c = row[x] as keyof typeof key;
      if (!(c in key)) { x++; continue; }
      let end = x;
      while (end < N && row[end] === c) end++;
      out[key[c]] += `M${x} ${y}h${end - x}v1h-${end - x}z`;
      x = end;
    }
  });
  cache.set(frame, out);
  return out;
}

export function Pixel({ name, scale = 1, still, className }: { name: PixelName; scale?: 1 | 2 | 3 | 4; still?: boolean; className?: string }) {
  const art = PIXELS[name];
  const moves = !still && art.seq.length > 1 && !reduced();
  const [step, setStep] = useState(0);

  useEffect(() => {
    setStep(0);
    if (!moves) return;
    const t = window.setInterval(() => setStep((s) => {
      if (s + 1 < art.seq.length) return s + 1;
      if (art.loop) return 0;
      window.clearInterval(t);
      return s;
    }), art.ms);
    return () => window.clearInterval(t);
  }, [art, moves]);

  const p = paths(art.frames[moves ? art.seq[step] : art.rest]);
  const size = N * scale;
  return (
    <svg className={`px${className ? ` ${className}` : ''}`} width={size} height={size} viewBox={`0 0 ${N} ${N}`} shapeRendering="crispEdges" aria-hidden>
      <path className="px-faint" d={p.faint} />
      <path d={p.ink} fill="currentColor" />
    </svg>
  );
}
