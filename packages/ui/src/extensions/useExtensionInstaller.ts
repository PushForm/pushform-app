// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef, useState } from 'react';
import type { ExtensionPlatform, InstallRequest } from '@pushform/extensions';

/** A host approval flow shared by the directory and contextual document recovery. */
export function useExtensionInstaller(platform: ExtensionPlatform) {
  const [request, setRequest] = useState<InstallRequest | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const prepare = async (read: (signal: AbortSignal) => Promise<InstallRequest>): Promise<void> => {
    controller.current?.abort(); const operation = new AbortController(); controller.current = operation;
    setError(null); setBusy(true);
    try { const next = await read(operation.signal); if (!operation.signal.aborted) setRequest(next); }
    catch (error) { if (!operation.signal.aborted) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (!operation.signal.aborted) setBusy(false); }
  };
  const install = async (): Promise<void> => {
    if (!request || busy) return;
    setBusy(true); setError(null); const operation = controller.current;
    try { await platform.install(request, request.manifest.permissions); if (!operation?.signal.aborted) setRequest(null); }
    catch (error) { if (!operation?.signal.aborted) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (!operation?.signal.aborted) setBusy(false); }
  };
  return { request, busy, error, prepare, install: () => void install(), cancel: () => {
    if (request && busy) return;
    controller.current?.abort(); setRequest(null); setError(null); setBusy(false);
  } };
}
