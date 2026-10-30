// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { toasts, type Toast, type ToastStore } from '../toasts';

function ToastMessage({ toast, store }: { toast: Toast; store: ToastStore }) {
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false);
  const remaining = useRef(toast.durationMs);
  useEffect(() => { remaining.current = toast.durationMs; }, [toast.revision, toast.durationMs]);
  useEffect(() => {
    if (hovered || focused || toast.durationMs === 0) return;
    const started = Date.now();
    const timer = setTimeout(() => store.dismiss(toast.id), remaining.current);
    return () => { clearTimeout(timer); remaining.current = Math.max(0, remaining.current - (Date.now() - started)); };
  }, [toast.id, toast.revision, toast.durationMs, hovered, focused, store]);
  return (
    <div className="pf-toast" role="group" aria-label="Notification"
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
      <span>{toast.message}</span>
      <button type="button" aria-label="Dismiss notification" onClick={() => store.dismiss(toast.id)}><span aria-hidden="true">×</span></button>
    </div>
  );
}

/** One application-wide host, outside editor clipping and without taking focus. */
export function ToastHost({ store = toasts }: { store?: ToastStore }) {
  const items = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => () => store.clear(), [store]);
  return createPortal(
    <section className="pf-toasts" aria-label="Notifications" aria-live="polite" aria-relevant="additions text">
      {items.map(toast => <ToastMessage key={toast.id} toast={toast} store={store} />)}
    </section>, document.body,
  );
}
