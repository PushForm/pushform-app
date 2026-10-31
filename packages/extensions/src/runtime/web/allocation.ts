// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors

/**
 * A budget for binary memory in an extension's runtime. Browsers give a worker's ArrayBuffers no limit of their own
 * (gigabytes can be allocated in a second), so before extension code runs, the worker bootstrap replaces
 * `ArrayBuffer` and the typed array constructors with ones that reserve their size against a live budget first, and
 * wraps the copying methods (`slice`, `map`, `filter`) the same way. A FinalizationRegistry returns the bytes when
 * a buffer is collected. An allocation that would exceed the budget throws a RangeError instead.
 *
 * This bounds the ways extension code can ask for binary memory directly. It is not a hard memory limit: strings,
 * objects and arrays live in the JavaScript heap, whose exhaustion ends the worker (which the host's heartbeat
 * then notices), and buffers made by platform APIs from data the extension already holds are not counted.
 */

export const DEFAULT_ALLOCATION_BUDGET = 256 * 1024 * 1024;

type Registry = { register(target: object, bytes: number): void };
type Scope = Record<string, unknown>;

const TYPED_ARRAYS = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
  'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'Float16Array'] as const;

export interface AllocationLimit {
  /** Bytes currently reserved. */
  live(): number;
}

export function installAllocationLimit(
  scope: Scope = globalThis as unknown as Scope,
  budget: number = DEFAULT_ALLOCATION_BUDGET,
  createRegistry: (release: (bytes: number) => void) => Registry = (release) => new FinalizationRegistry<number>(release),
): AllocationLimit {
  let live = 0;
  const registry = createRegistry((bytes) => { live -= bytes; });
  const reserve = (bytes: number): void => {
    if (!Number.isFinite(bytes) || bytes < 0) return; // Invalid sizes are refused by the engine itself.
    if (live + bytes > budget)
      throw new RangeError(`limit.exceeded: an extension may hold at most ${Math.round(budget / 1024 / 1024)} MiB of binary data at once.`);
    live += bytes;
  };
  const track = (target: object, bytes: number): void => {
    if (bytes > 0) registry.register(target, bytes);
  };
  /**
   * Set by the limited constructors. A copying method's result is built through the source's species constructor,
   * which counts it when it is one of the limited ones; otherwise (a source made by the platform) the copy is counted
   * here, so nothing is counted twice or missed.
   */
  let counted = false;
  const copied = <T extends object>(bytes: number, make: () => T, bufferOf: (result: T) => object): T => {
    if (live + bytes > budget) reserve(bytes);
    counted = false;
    const result = make();
    if (!counted) {
      reserve(bytes);
      track(bufferOf(result), bytes);
    }
    return result;
  };
  const seal = (target: object, key: string, value: unknown): void => {
    Object.defineProperty(target, key, { value, writable: false, enumerable: false, configurable: false });
  };

  const NativeArrayBuffer = scope.ArrayBuffer as ArrayBufferConstructor;
  // The shared prototype of every typed array, taken before the constructors are replaced.
  const TypedArrayPrototype = Object.getPrototypeOf((scope.Uint8Array as Uint8ArrayConstructor).prototype) as Record<string, unknown>;
  class LimitedArrayBuffer extends NativeArrayBuffer {
    constructor(length: number, options?: { maxByteLength?: number }) {
      const bytes = Math.max(Number(length) || 0, Number(options?.maxByteLength) || 0);
      reserve(bytes);
      try {
        // Resizable buffers take an options argument the ES2023 type library does not describe.
        super(...((options === undefined ? [length] : [length, options]) as [number]));
      } catch (error) {
        live -= bytes;
        throw error;
      }
      track(this, bytes);
      counted = true;
    }
  }
  const nativeSlice = NativeArrayBuffer.prototype.slice;
  seal(NativeArrayBuffer.prototype, 'slice', function slice(this: ArrayBuffer, start?: number, end?: number) {
    const size = this.byteLength;
    const from = start === undefined ? 0 : start < 0 ? Math.max(size + start, 0) : Math.min(start, size);
    const to = end === undefined ? size : end < 0 ? Math.max(size + end, 0) : Math.min(end, size);
    return copied(Math.max(to - from, 0), () => nativeSlice.call(this, start, end), (copy) => copy);
  });
  seal(scope, 'ArrayBuffer', LimitedArrayBuffer);

  for (const name of TYPED_ARRAYS) {
    const Native = scope[name] as (new (...args: unknown[]) => ArrayBufferView & { length: number }) & { BYTES_PER_ELEMENT: number } | undefined;
    if (!Native) continue;
    const element = Native.BYTES_PER_ELEMENT;
    const Limited = class extends (Native as unknown as new (...args: unknown[]) => object) {
      constructor(...args: unknown[]) {
        const [first] = args;
        // A buffer argument makes a view over memory already counted; a length or an array-like allocates.
        const allocates = !(first instanceof NativeArrayBuffer) && !(typeof SharedArrayBuffer !== 'undefined' && first instanceof SharedArrayBuffer);
        const known = typeof first === 'number' ? first
          : allocates && typeof first === 'object' && first !== null && typeof (first as { length?: unknown }).length === 'number' ? (first as { length: number }).length
            : null;
        const before = allocates && known !== null ? known * element : 0;
        reserve(before);
        try {
          super(...args);
        } catch (error) {
          live -= before;
          throw error;
        }
        const bytes = allocates ? (this as unknown as ArrayBufferView).byteLength : 0;
        // Iterables reveal their length only once copied; count them now, refusing if they went over.
        if (allocates && bytes > before) {
          try {
            reserve(bytes - before);
          } catch (error) {
            live -= before;
            throw error;
          }
        }
        track((this as unknown as ArrayBufferView).buffer, bytes);
        if (allocates) counted = true;
      }
    };
    seal(scope, name, Limited);
  }

  // The copying methods allocate a result as large as the source.
  for (const method of ['slice', 'map', 'filter'] as const) {
    const native = TypedArrayPrototype[method] as (this: ArrayBufferView & { length: number }, ...args: unknown[]) => ArrayBufferView;
    if (typeof native !== 'function') continue;
    seal(TypedArrayPrototype, method, function copy(this: ArrayBufferView & { length: number }, ...args: unknown[]) {
      // filter's result can be smaller; the source size bounds it.
      return copied(this.byteLength, () => native.apply(this, args), (result) => result.buffer);
    });
  }

  return { live: () => live };
}
