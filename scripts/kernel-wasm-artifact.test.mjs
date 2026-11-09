// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/* global Buffer */
import { describe, expect, it } from 'vitest';
import { sourceFileHash } from './kernel-wasm-artifact.mjs';

describe('sourceFileHash', () => {
  it('ignores the line endings Git writes on a Windows checkout', () => {
    expect(sourceFileHash(Buffer.from('fn main() {\r\n}\r\n'))).toBe(sourceFileHash(Buffer.from('fn main() {\n}\n')));
  });

  it('still sees a change of content, including bytes that are not text', () => {
    expect(sourceFileHash(Buffer.from('a\n'))).not.toBe(sourceFileHash(Buffer.from('b\n')));
    expect(sourceFileHash(Buffer.from([0xff, 0x00, 0x0a]))).not.toBe(sourceFileHash(Buffer.from([0xfe, 0x00, 0x0a])));
  });
});
