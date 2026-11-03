// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it, vi } from 'vitest';
import { openThirdPartyNotices } from './thirdPartyNotices';

describe('openThirdPartyNotices', () => {
  it('leaves the click to the link in the browser', async () => {
    const event = { preventDefault: vi.fn() };
    const open = vi.fn(async () => {});
    await expect(openThirdPartyNotices(event, false, open)).resolves.toBe(true);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('opens the installed notices file on the desktop instead of following the link', async () => {
    const event = { preventDefault: vi.fn() };
    const open = vi.fn(async () => {});
    await expect(openThirdPartyNotices(event, true, open)).resolves.toBe(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('reports a desktop build without the installed file', async () => {
    const event = { preventDefault: vi.fn() };
    await expect(openThirdPartyNotices(event, true, () => Promise.reject(new Error('missing')))).resolves.toBe(false);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });
});
