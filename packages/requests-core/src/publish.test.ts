// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { documentTools } from './agents/document.ts';
import { PUBLISH_TOOL, PUBLISHING_INFO_TOOL, SAVE_TOOL, publishAnswerOf, quietPublishAnswer } from './publish.ts';

describe('saving and publishing from AI Chat', () => {
  const names = (document: Parameters<typeof documentTools>[0]) => documentTools(document).map(tool => tool.name);

  it('offers saving to an editable document that can save, and publishing only to a model tab that can publish', () => {
    expect(names({ type: 'model', apiVersion: 1, edit: 1, save: 1, publish: 1 })).toEqual(expect.arrayContaining([SAVE_TOOL, PUBLISHING_INFO_TOOL, PUBLISH_TOOL]));
    expect(names({ type: 'layout', apiVersion: 1, save: 1, publish: 1 })).toContain(SAVE_TOOL);
    expect(names({ type: 'layout', apiVersion: 1, save: 1, publish: 1 })).not.toContain(PUBLISH_TOOL);
    expect(names({ type: 'model', apiVersion: 1, edit: 1 })).not.toContain(SAVE_TOOL);
    expect(names({ type: 'model', apiVersion: 1, guidance: 1, save: 1, publish: 1 })).not.toContain(SAVE_TOOL);
  });

  it('ends quietly only after a publication made or a card cancelled', () => {
    expect(quietPublishAnswer(publishAnswerOf('{"ok":true,"outcome":"published","title":"Shaker base","url":"https://commons.pushform.io/#models/design-1"}'))).toBe(true);
    expect(quietPublishAnswer(publishAnswerOf('{"ok":true,"outcome":"cancel"}'))).toBe(true);
    expect(quietPublishAnswer(publishAnswerOf('{"ok":false,"outcome":"failed","error":"x"}'))).toBe(false);
    expect(quietPublishAnswer(publishAnswerOf('{"ok":false,"outcome":"unavailable","error":"x"}'))).toBe(false);
    expect(publishAnswerOf('{"ok":true,"choice":"clone"}')).toBeNull();
  });
});
