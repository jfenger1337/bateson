import { useEffect, useRef } from 'react';

/** The page's height, kept in --page-h on the root while it is shown: the drop above an interview question or a
 *  finding (app.css) gives way by it, so a page that would fit the window does, without a scroll. */
export function usePageHeight<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const page = ref.current;
    if (!page) return;
    const root = document.documentElement;
    const ro = new ResizeObserver(() => root.style.setProperty('--page-h', `${Math.ceil(page.offsetHeight)}px`));
    ro.observe(page);
    return () => { ro.disconnect(); root.style.removeProperty('--page-h'); };
  }, []);
  return ref;
}
