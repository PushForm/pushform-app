// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureRequestScreenshot } from './requestScreenshot';
import type { DocumentSession, DocumentTab } from './session';

afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const sessionFor = (tab: DocumentTab): DocumentSession => ({ active: tab, tabs: [tab] }) as unknown as DocumentSession;
describe('request screenshots', () => {
  it('captures the Layout page inside its canvas wrapper', async () => {
    document.body.innerHTML = '<div class="pf-layout-workspace"><div><canvas class="pf-layout-page"></canvas></div></div>';
    const blob = new Blob(['page'], { type: 'image/png' });
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback(blob));
    const tab = { type: 'layout' } as DocumentTab;
    expect(await captureRequestScreenshot(sessionFor(tab), tab)).toBe(blob);
  });
  it('uses the model viewport capture with a bounded size and preserves its aspect ratio', async () => {
    document.body.innerHTML = '<div class="pf-viewport"><canvas width="4000" height="2000"></canvas></div>';
    const captureThumbnail = vi.fn(async () => 'data:image/png;base64,eA==');
    const blob = new Blob(['model'], { type: 'image/png' });
    vi.stubGlobal('fetch', vi.fn(async () => ({ blob: async () => blob })));
    const tab = { type: 'model', app: { viewport: { captureThumbnail } } } as unknown as DocumentTab;
    expect(await captureRequestScreenshot(sessionFor(tab), tab)).toBe(blob);
    expect(captureThumbnail).toHaveBeenCalledWith(1920, 960);
  });
  it('never captures a different active tab or a closed document', async () => {
    const tab = { type: 'layout' } as DocumentTab;
    const other = { type: 'layout' } as DocumentTab;
    expect(await captureRequestScreenshot(sessionFor(other), tab)).toBeNull();
    expect(await captureRequestScreenshot({ active: tab, tabs: [] } as unknown as DocumentSession, tab)).toBeNull();
  });
});
