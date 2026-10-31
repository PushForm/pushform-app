// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// The parts of the wabt package (WebAssembly text to binary) the tests use; it ships no types.
declare module 'wabt' {
  interface WabtModule {
    toBinary(options: Record<string, unknown>): { buffer: Uint8Array };
    destroy(): void;
  }
  interface Wabt {
    parseWat(filename: string, source: string, features?: Record<string, boolean>): WabtModule;
  }
  const init: () => Promise<Wabt>;
  export default init;
}
