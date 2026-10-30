// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { DocumentSession, DocumentTab } from './session';

export async function captureRequestScreenshot(session: DocumentSession, tab: DocumentTab): Promise<Blob | null> {
  if (session.active !== tab || !session.tabs.includes(tab)) return null;
  if (tab.type === 'model') {
    const canvas = document.querySelector<HTMLCanvasElement>('.pf-viewport canvas');
    if (!canvas || !canvas.width || !canvas.height) return null;
    const scale = Math.min(1, 1920 / canvas.width, 1080 / canvas.height);
    const url = await tab.app.viewport.captureThumbnail(Math.round(canvas.width * scale), Math.round(canvas.height * scale));
    return url ? (await fetch(url)).blob() : null;
  }
  const canvas = document.querySelector<HTMLCanvasElement>('.pf-layout-workspace canvas.pf-layout-page');
  if (!canvas || !canvas.width || !canvas.height) return null;
  return new Promise(resolve => { try { canvas.toBlob(resolve, 'image/png'); } catch { resolve(null); } });
}
