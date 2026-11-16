import { Spinner } from '@/components/ui/spinner';

// Where a page will be, while it loads. The ripple is SMIL, which the reduced-motion rule in base.css
// cannot stop, so reduced motion gets the CSS-spun circle instead, which that rule holds still.
export function Loading() {
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return (
    <div className="page-loading" role="status" aria-label="Loading">
      <Spinner variant={still ? 'circle' : 'ring'} size={32} aria-hidden />
    </div>
  );
}
