// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { CloudFile } from '@pushform/cloud';
import type { ThumbnailService } from './thumbnailService';

export const ThumbnailContext = createContext<ThumbnailService | undefined>(undefined);

/** Views own only revocable object URLs; the account's service owns pixels and background work. */
export function useThumbnails(files: readonly CloudFile[], enabled = true): Map<string, string> {
  const service = useContext(ThumbnailContext);
  const key = enabled ? JSON.stringify(files.map(file => [file.id, file.current_revision_id])) : '';
  const latest = useRef(files); latest.current = files;
  const [result, setResult] = useState<{ key: string; urls: Map<string, string> }>({ key: '', urls: new Map() });
  useEffect(() => {
    if (!enabled || !service) return;
    let active = true;
    const urls = new Map<string, string>(), attempts = new Map<string, number>();
    const visible = latest.current;
    const load = (id?: string): void => {
      for (const file of visible) if (!id || id === file.id) {
        const attempt = (attempts.get(file.id) ?? 0) + 1; attempts.set(file.id, attempt);
        void service.request(file).then(bytes => {
          if (!active || !bytes || attempts.get(file.id) !== attempt) return;
          const previous = urls.get(file.id);
          urls.set(file.id, URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' })));
          setResult({ key, urls: new Map(urls) });
          if (previous) URL.revokeObjectURL(previous);
        }).catch(() => {});
      }
    };
    const unsubscribe = service.subscribe(load);
    load();
    return () => { active = false; unsubscribe(); for (const url of urls.values()) URL.revokeObjectURL(url); };
  }, [service, key, enabled]);
  return result.key === key ? result.urls : new Map();
}
