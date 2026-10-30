// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { relayedCommentBody, TrackerError } from './tracker.ts';

describe('relayedCommentBody', () => {
  it('returns the rest of a comment whose first line is Requester:', () => {
    expect(relayedCommentBody('Requester:\nWe need one more detail.\nWhich browser?')).toBe('We need one more detail.\nWhich browser?');
    expect(relayedCommentBody('Requester: Thanks, this ships next week.')).toBe('Thanks, this ships next week.');
    expect(relayedCommentBody('  Requester:   \r\nWindows line endings')).toBe('Windows line endings');
  });
  it('ignores other comments and empty relays', () => {
    expect(relayedCommentBody('Internal: do not relay')).toBeNull();
    expect(relayedCommentBody('Note to requester: hi')).toBeNull();
    expect(relayedCommentBody('Requester:')).toBeNull();
    expect(relayedCommentBody('Requester:\n   ')).toBeNull();
  });
  it('TrackerError carries a code', () => {
    const error = new TrackerError('rate_limited', 'slow down');
    expect(error.code).toBe('rate_limited');
    expect(error.name).toBe('TrackerError');
    expect(error.message).toBe('slow down');
  });
});
