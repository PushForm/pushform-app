// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { inspectorCaptureSchema, inspectorDeclarationSchema } from './inspector';
import { extensionManifestSchema } from './manifest';

it('validates bounded declarations and requires an explicit scope for shared body captures', () => {
  expect(inspectorDeclarationSchema.parse({ targets: ['bodyOccurrence'] }).multiSelection).toBe('none');
  expect(inspectorDeclarationSchema.safeParse({ targets: ['body', 'body'] }).success).toBe(false);
  const capture = { binding: 'captured', revision: 4, scope: 'placement', targets: [{ kind: 'body', id: 12 }], placementCount: 2, overrideCount: 0 };
  expect(inspectorCaptureSchema.safeParse(capture).success).toBe(false);
  expect(inspectorCaptureSchema.safeParse({ ...capture, scope: 'shared' }).success).toBe(true);
  expect(inspectorCaptureSchema.safeParse({ ...capture, scope: 'shared', targets: Array.from({ length: 201 }, () => ({ kind: 'body', id: 12 })) }).success).toBe(false);
});

it('keeps inspector declarations off unrelated contribution targets', () => {
  const manifest = { id: 'com.example.parts', name: 'Parts', publisher: 'Example', version: '1.0.0', apiVersion: '^0.1.0', editors: ['modeling'], defaultLocale: 'en', license: 'MIT', files: {}, permissions: [], contributions: [{ target: 'model.command', id: 'com.example.parts.open', name: 'Open', inspector: { targets: ['bodyOccurrence'] } }] };
  expect(extensionManifestSchema.safeParse(manifest).success).toBe(false);
});
