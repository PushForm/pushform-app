// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useState } from 'react';

/** How long a progress message has stayed the same, in whole seconds, once it has for at least `after` seconds; else 0. */
export function useStallSeconds(message: string | null | undefined, after = 10): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    setSeconds(0);
    if (message === null || message === undefined) return;
    const since = Date.now();
    const timer = setInterval(() => { const s = Math.floor((Date.now() - since) / 1000); setSeconds(s >= after ? s : 0); }, 1000);
    return () => clearInterval(timer);
  }, [message, after]);
  return seconds;
}

/** The note a stalled step shows beside its progress: a long step blocks the import worker, which cannot report mid-step. */
export function stallNote(seconds: number): string { return seconds ? ` (this step has run for ${seconds} s)` : ''; }
