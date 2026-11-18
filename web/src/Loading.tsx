import { Pixel } from './Pixel';

// Where a page will be, while it loads: the hourglass, its sand running through. Under reduced motion it stands still.
export function Loading() {
  return (
    <div className="page-loading" role="status" aria-label="Loading">
      <Pixel name="hourglass" scale={2} />
    </div>
  );
}
