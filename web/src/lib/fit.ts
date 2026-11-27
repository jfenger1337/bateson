import { useEffect, useRef } from 'react';

/** The page's height, kept in --page-h on the root while it is shown: the drop above an interview question or a
 *  finding (app.css) gives way by it, so a page that would fit the window does, without a scroll.
 *
 *  An interview round also draws all its questions again out of sight (.iv-measure, Interview.tsx), and the height kept
 *  is then the tallest the page would be with any of its questions. The drop is the round's, not the question's,
 *  so after Next the title starts on the same line as the one before it. */
export function usePageHeight<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const page = ref.current;
    if (!page) return;
    const root = document.documentElement;
    const measure = () => {
      let h = page.offsetHeight;
      const shown = page.querySelector<HTMLElement>(':scope > .iv-main > .iv-q');
      if (shown) for (const copy of page.querySelectorAll<HTMLElement>('.iv-measure > .iv-q')) h = Math.max(h, page.offsetHeight - shown.offsetHeight + copy.offsetHeight);
      root.style.setProperty('--page-h', `${Math.ceil(h)}px`);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(page);
    // The copies change height with the width and once the fonts are in, which the page itself may not.
    for (const copy of page.querySelectorAll('.iv-measure > .iv-q')) ro.observe(copy);
    return () => { ro.disconnect(); root.style.removeProperty('--page-h'); };
  }, []);
  return ref;
}
