// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useLayoutEffect, useRef, useState } from 'react';

export function SiteFooter({ docked }: { docked: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const [floating, setFloating] = useState(false);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    if (docked) { setFloating(true); return; }
    const timer = setTimeout(() => setFloating(false), 220);
    return () => clearTimeout(timer);
  }, [docked]);
  useLayoutEffect(() => {
    if (!floating || !root.current) return;
    const element = root.current;
    const measure = () => setHeight(element.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [floating]);
  return <>
    <div ref={root} className={`site-footer-shell${floating ? ` is-floating${docked ? ' is-visible' : ''}` : ''}`}>
      <footer className="site-footer"><span>Good projects start with shared ideas.</span><div><a href="https://pushform.io">PushForm</a><a href="https://pushform.io/terms">Terms</a><a href="https://pushform.io/privacy">Privacy</a></div></footer>
    </div>
    {floating && <div aria-hidden="true" style={{ height }} />}
  </>;
}
