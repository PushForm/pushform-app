// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type * as Protocol from '@pushform/extension-protocol';
import { EXTENSION_ERROR_CODES as HOST_CODES, EXTENSION_PERMISSIONS } from '@pushform/extension-protocol';
import type * as Sdk from '@pushform/extension-sdk';
import { EXTENSION_ERROR_CODES as SDK_CODES } from '@pushform/extension-sdk';

/**
 * The SDK's types are written separately from the host's (the SDK is MIT, the host GPL), so this file keeps them
 * the same: each pair must be assignable both ways, which the type check enforces.
 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const same = <A, B>(proof: Same<A, B>): Same<A, B> => proof;

describe('SDK types', () => {
  it('match the host protocol', () => {
    expect(same<Sdk.UiNode, Protocol.UiNode>(true)).toBe(true);
    expect(same<Sdk.UiEvent, Protocol.UiEvent>(true)).toBe(true);
    expect(same<Sdk.UiTreeItem, Protocol.UiTreeItem>(true)).toBe(true);
    expect(same<Sdk.UiQuantity, Protocol.UiQuantity>(true)).toBe(true);
    expect(same<Sdk.ExtensionPermission, Protocol.ExtensionPermission>(true)).toBe(true);
    expect(same<Sdk.ExtensionErrorCode, Protocol.ExtensionErrorCode>(true)).toBe(true);
    expect(same<Sdk.ExtensionErrorData, Protocol.ExtensionErrorData>(true)).toBe(true);
  });

  it('list the same error codes as the host', () => {
    expect([...SDK_CODES].sort()).toEqual([...HOST_CODES].sort());
    expect(EXTENSION_PERMISSIONS.length).toBe(12);
  });
});
