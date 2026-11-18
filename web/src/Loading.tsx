import { Pixel } from './Pixel';

// Where a page will be, while it loads: bateson's mark waiting, its rings taking turns to fill, stepping toward the
// dot. On the empty page they fill for good. Under reduced motion it stands still.
export function Loading() {
  return (
    <div className="page-loading" role="status" aria-label="Loading">
      <Pixel name="wait" scale={2} />
    </div>
  );
}
