// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors

/**
 * A budget for binary memory in an extension's runtime. Browsers give a worker's ArrayBuffers no limit of their own
 * (gigabytes can be allocated in a second), so before extension code runs, the worker bootstrap puts every way the
 * runtime's scope has of making binary data behind a live budget:
 *
 * - `ArrayBuffer`, `SharedArrayBuffer` (where the browser offers it) and the typed array constructors are replaced by
 *   plain functions, not subclasses, that reserve the size first. The originals are reachable from nowhere: each
 *   prototype's `constructor` names the replacement, and the replacements inherit from what the originals inherit
 *   from (`Function.prototype`, or the abstract typed array constructor, which cannot construct anything).
 * - The methods that copy or move buffers (`slice`, `transfer`, `map`, `toSorted`, `Uint8Array.fromBase64` and the
 *   rest) count their result; a transfer frees the source's share at once, because the source is left empty.
 * - Platform objects that hold or produce bytes are counted too: a Blob or File by its size when it is made, read or
 *   sliced, a FormData by the Blobs put into it, `structuredClone` copies, `TextEncoder` output, chunks read from
 *   Blob streams and compression streams, file readers, Web Crypto results and keys, and binary data that arrives
 *   from the host (`admit`).
 * - What cannot be counted reliably is removed from the scope, because extensions have no use for it in this
 *   runtime: message channels and broadcast channels inside the worker (a message to oneself is an uncounted copy
 *   held by the event), `postMessage` to the frame, `Response` and `Request` (whose bodies and clones copy data where
 *   nothing can see it), readable byte streams (which move buffers), image, canvas, media and GPU interfaces, font
 *   faces, notifications and user timing marks (which keep copies of their data).
 *
 * A FinalizationRegistry returns the bytes when an object is collected. An allocation that would exceed the budget
 * throws a RangeError instead; where the size is known only once a platform method has finished, the result is
 * refused (and dropped) then, so the memory over the budget is never held, only made for a moment from data the
 * extension already holds. Every function the budget calls at run time was taken before extension code ran, so
 * changing built-ins afterwards cannot steer it.
 *
 * This bounds binary memory, not all memory: strings, objects and arrays live in the JavaScript heap, whose
 * exhaustion ends the worker (which the host's heartbeat then notices). Messages the extension posts to the host
 * are copied for the host, which bounds them itself.
 */

export const DEFAULT_ALLOCATION_BUDGET = 256 * 1024 * 1024;

type Registry = { register(target: object, bytes: number, token?: object): void; unregister?(token: object): boolean };
type Scope = Record<string, unknown>;
type Fn = (...args: unknown[]) => unknown;
type Ctor = new (...args: unknown[]) => object;
type Proto = Record<PropertyKey, unknown>;

const TYPED_ARRAYS = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
  'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'Float16Array'] as const;

/** Interfaces removed from the runtime's scope, with every prototype that holds them. */
const REMOVED_GLOBALS = [
  'MessageChannel', 'BroadcastChannel', 'Response', 'Request', 'OffscreenCanvas', 'ImageData', 'createImageBitmap',
  'VideoFrame', 'AudioData', 'VideoDecoder', 'VideoEncoder', 'AudioDecoder', 'AudioEncoder', 'ImageDecoder',
  'EncodedVideoChunk', 'EncodedAudioChunk', 'MediaSource', 'ManagedMediaSource', 'FontFace', 'Notification',
  'PerformanceMark', 'PerformanceMeasure', 'postMessage',
] as const;

export interface AllocationLimit {
  /** Bytes currently reserved. */
  live(): number;
  /**
   * Counts the binary data in a value that came from outside the extension's code, such as a message from the host.
   * Past the budget it throws a RangeError, unless `force` is set, when the bytes are counted anyway (so later
   * allocations are refused).
   */
  admit(value: unknown, force?: boolean): void;
}

/** The parts of a runtime port the host's messages arrive on. */
export interface MessageSource {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  start(): void;
}

/**
 * Wraps `transport` so that the binary data in each host message is counted once `limit()` returns a budget. A
 * successful answer to a call that would not fit becomes a `limit.exceeded` failure of that call; anything else is
 * delivered and counted anyway, so that the extension's own allocations are refused instead. Messages are read with
 * the platform's own `data` getter, taken now, so extension code that changes it cannot hide what arrives.
 */
export function admitHostMessages<T extends { listen(handler: (message: unknown) => void): () => void }>(
  transport: T, port: MessageSource, limit: () => AllocationLimit | null,
  messageData: (this: MessageEvent) => unknown = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data')!.get!,
): T {
  const apply = Reflect.apply;
  const RangeErrorCtor = RangeError;
  return {
    ...transport,
    listen(handler: (message: unknown) => void) {
      const onMessage = (event: MessageEvent) => {
        const message = apply(messageData, event, []);
        const budget = limit();
        if (budget) {
          try {
            budget.admit(message);
          } catch (error) {
            const answer = message as { type?: unknown; id?: unknown; ok?: unknown } | null;
            if (!(error instanceof RangeErrorCtor)) throw error;
            if (answer?.type === 'response' && answer.ok === true) {
              handler({ type: 'response', id: answer.id, ok: false, error: { code: 'limit.exceeded', message: refusedAnswer } });
              return;
            }
            budget.admit(message, true);
          }
        }
        handler(message);
      };
      port.addEventListener('message', onMessage);
      port.start();
      return () => port.removeEventListener('message', onMessage);
    },
  };
}

const refusedAnswer = 'The answer would take the extension past its budget for binary data.';

export function installAllocationLimit(
  scope: Scope = globalThis as unknown as Scope,
  budget: number = DEFAULT_ALLOCATION_BUDGET,
  createRegistry: (release: (bytes: number) => void) => Registry = (release) => new FinalizationRegistry<number>(release),
): AllocationLimit {
  // Everything used at run time is taken now, before extension code can change it.
  const { apply, construct, defineProperty, getOwnPropertyDescriptor, getPrototypeOf, setPrototypeOf, ownKeys } = Reflect;
  const { hasOwn, create } = Object;
  const arrayFrom = Array.from;
  const isArray = Array.isArray;
  const { max: mathMax, trunc } = Math;
  const finite = Number.isFinite;
  const RangeErrorCtor = RangeError;
  const TypeErrorCtor = TypeError;
  const iteratorKey = Symbol.iterator;
  const weakMapGet = WeakMap.prototype.get, weakMapSet = WeakMap.prototype.set, weakMapHas = WeakMap.prototype.has;
  const weakSetHas = WeakSet.prototype.has, weakSetAdd = WeakSet.prototype.add;
  const NativePromise = scope.Promise as PromiseConstructor;
  const promiseThen = NativePromise.prototype.then as Fn;
  const promiseReject = NativePromise.reject as Fn;
  const getter = (proto: unknown, key: PropertyKey): Fn | undefined =>
    proto ? getOwnPropertyDescriptor(proto as object, key)?.get as Fn | undefined : undefined;
  /** Calls a native getter or method; undefined when `target` is not what it expects (a brand check). */
  const attempt = (fn: Fn | undefined, target: unknown): unknown => {
    if (!fn || target === null || (typeof target !== 'object' && typeof target !== 'function')) return undefined;
    try {
      return apply(fn, target, []);
    } catch {
      return undefined;
    }
  };
  const isObject = (value: unknown): value is object => value !== null && (typeof value === 'object' || typeof value === 'function');
  const then = (promise: unknown, onValue: (value: unknown) => unknown, onError: (error: unknown) => unknown): unknown =>
    apply(promiseThen, promise, [onValue, onError]);

  let live = 0;
  const registry = createRegistry((bytes) => { live -= bytes; });
  const register = registry.register.bind(registry);
  const unregister = registry.unregister?.bind(registry);
  /** Every object counted, with the bytes it holds against the budget. */
  const tracked = new WeakMap<object, number>();
  const refusalMessage = `limit.exceeded: an extension may hold at most ${Math.round(budget / 1024 / 1024)} MiB of binary data at once.`;
  const refusal = (): RangeError => new RangeErrorCtor(refusalMessage);
  /** Throws unless `bytes` more would fit. */
  const check = (bytes: number): void => {
    if (finite(bytes) && bytes > 0 && live + bytes > budget) throw refusal();
  };
  const reserve = (bytes: number): number => {
    if (!finite(bytes) || bytes <= 0) return 0; // Invalid sizes are refused by the engine itself.
    if (live + bytes > budget) throw refusal();
    live += bytes;
    return bytes;
  };
  const isTracked = (target: object): boolean => apply(weakMapHas, tracked, [target]) as boolean;
  /** Ties `bytes` (already reserved) to `target`, returned when it is collected. */
  const hold = (target: object, bytes: number): void => {
    if (bytes > 0) register(target, bytes, target);
  };

  const NativeArrayBuffer = scope.ArrayBuffer as ArrayBufferConstructor;
  const BufferPrototype = NativeArrayBuffer.prototype as unknown as Proto;
  const bufferLength = getter(BufferPrototype, 'byteLength');
  const bufferMax = getter(BufferPrototype, 'maxByteLength');
  const bufferResizable = getter(BufferPrototype, 'resizable');
  const bufferDetached = getter(BufferPrototype, 'detached');
  const NativeShared = scope.SharedArrayBuffer as SharedArrayBufferConstructor | undefined;
  const SharedPrototype = NativeShared?.prototype as unknown as Proto | undefined;
  const sharedLength = getter(SharedPrototype, 'byteLength');
  const sharedMax = getter(SharedPrototype, 'maxByteLength');
  const sharedGrowable = getter(SharedPrototype, 'growable');
  // The shared prototype of every typed array, and its abstract constructor, which constructs nothing.
  const TypedArray = getPrototypeOf(scope.Uint8Array as object) as Ctor;
  const TypedArrayPrototype = TypedArray.prototype as unknown as Proto;
  const viewBufferOfTyped = getter(TypedArrayPrototype, 'buffer');
  const typedLength = getter(TypedArrayPrototype, 'length');
  const typedByteLength = getter(TypedArrayPrototype, 'byteLength');
  const DataViewPrototype = (scope.DataView as { prototype?: unknown } | undefined)?.prototype;
  const viewBufferOfDataView = getter(DataViewPrototype, 'buffer');
  const dataViewByteLength = getter(DataViewPrototype, 'byteLength');
  const NativeBlob = scope.Blob as Ctor | undefined;
  const blobSize = getter(NativeBlob?.prototype, 'size');
  const mapSize = getter((scope.Map as MapConstructor).prototype, 'size');
  const mapForEach = (scope.Map as MapConstructor).prototype.forEach as Fn;
  const setSize = getter((scope.Set as SetConstructor).prototype, 'size');
  const setForEach = (scope.Set as SetConstructor).prototype.forEach as Fn;

  /** The bytes an ArrayBuffer, SharedArrayBuffer or Blob holds (a resizable buffer at its maximum); else undefined. */
  const sizeOf = (target: unknown): number | undefined => {
    const length = attempt(bufferLength, target);
    if (length !== undefined) return attempt(bufferResizable, target) === true ? attempt(bufferMax, target) as number : length as number;
    const shared = attempt(sharedLength, target);
    if (shared !== undefined) return attempt(sharedGrowable, target) === true ? attempt(sharedMax, target) as number : shared as number;
    return attempt(blobSize, target) as number | undefined;
  };
  const bufferOfView = (view: unknown): object | undefined =>
    (attempt(viewBufferOfTyped, view) ?? attempt(viewBufferOfDataView, view)) as object | undefined;
  /**
   * Counts `target` at its actual size, `reserved` bytes of which were reserved for it beforehand. Past the budget it
   * returns the reservation and throws, and the caller drops the object.
   */
  const settle = (target: object, reserved: number, force = false): void => {
    if (isTracked(target)) {
      live -= reserved;
      return;
    }
    const actual = sizeOf(target) ?? reserved;
    if (actual > reserved && !force && live + actual - reserved > budget) {
      live -= reserved;
      throw refusal();
    }
    live += actual - reserved;
    apply(weakMapSet, tracked, [target, actual]);
    hold(target, actual);
  };
  /** Counts a buffer, Blob or view made by the platform, unless it is counted already. */
  const adopt = (value: unknown, force = false): void => {
    if (!isObject(value)) return;
    const buffer = bufferOfView(value) ?? value;
    if (sizeOf(buffer) !== undefined) settle(buffer, 0, force);
  };
  /** Returns the share of a counted buffer that a transfer left empty. */
  const releaseDetached = (buffer: unknown): void => {
    if (!unregister || !isObject(buffer) || attempt(bufferDetached, buffer) !== true) return;
    const bytes = apply(weakMapGet, tracked, [buffer]) as number | undefined;
    if (!bytes || !unregister(buffer)) return;
    live -= bytes;
    apply(weakMapSet, tracked, [buffer, 0]);
  };
  /** Counts every buffer and Blob inside a structured-clone result or a message. */
  const admit = (value: unknown, force = false): void => {
    const stack = create(null) as Record<number, unknown>;
    let top = 0;
    stack[top++] = value;
    const seen = new WeakSet<object>();
    while (top > 0) {
      const item = stack[--top];
      if (!isObject(item) || apply(weakSetHas, seen, [item])) continue;
      apply(weakSetAdd, seen, [item]);
      const view = bufferOfView(item);
      if (view) { stack[top++] = view; continue; }
      if (sizeOf(item) !== undefined) { settle(item, 0, force); continue; }
      if (attempt(mapSize, item) !== undefined) {
        apply(mapForEach, item, [(entry: unknown, key: unknown) => { stack[top++] = key; stack[top++] = entry; }]);
        continue;
      }
      if (attempt(setSize, item) !== undefined) {
        apply(setForEach, item, [(entry: unknown) => { stack[top++] = entry; }]);
        continue;
      }
      if (isArray(item)) {
        const list = item as unknown[];
        for (let i = 0; i < list.length; i++) if (isObject(list[i])) stack[top++] = list[i];
        continue;
      }
      const keys = ownKeys(item);
      for (let i = 0; i < keys.length; i++) {
        const descriptor = getOwnPropertyDescriptor(item, keys[i]!);
        if (descriptor && hasOwn(descriptor, 'value') && isObject(descriptor.value)) stack[top++] = descriptor.value;
      }
    }
  };

  const seal = (target: object, key: PropertyKey, value: unknown): void => {
    defineProperty(target, key, { value, writable: false, enumerable: false, configurable: false });
  };
  /** Replaces the method `key` of `target` with `wrap(native)`, keeping its name and length. */
  const replaceMethod = (target: object | undefined, key: string, wrap: (native: Fn) => Fn): void => {
    const native = target ? (target as Proto)[key] : undefined;
    if (typeof native !== 'function') return;
    const replacement = wrap(native as Fn);
    defineProperty(replacement, 'name', { value: native.name, configurable: true });
    defineProperty(replacement, 'length', { value: native.length, configurable: true });
    seal(target!, key, replacement);
  };
  /**
   * Replaces the constructor `name` with a function that builds instances through `make`. It is not a subclass, so
   * nothing leads back to the original: it shares the original's prototype (whose `constructor` it becomes), its
   * statics, and its parent (`parent`, when that is replaced too).
   */
  const replaceConstructor = (name: string, Native: Ctor, make: (args: ArrayLike<unknown>, newTarget: Ctor) => object, parent?: object): Ctor => {
    const Replacement = function (this: unknown, ...args: unknown[]) {
      if (new.target === undefined) throw new TypeErrorCtor(`Constructor ${name} requires 'new'`);
      return make(args, new.target as unknown as Ctor);
    } as unknown as Ctor;
    for (const key of ownKeys(Native)) {
      if (key === 'prototype' || key === 'length' || key === 'name') continue;
      defineProperty(Replacement, key, getOwnPropertyDescriptor(Native, key)!);
    }
    defineProperty(Replacement, 'name', { value: name, configurable: true });
    defineProperty(Replacement, 'length', { value: Native.length, configurable: true });
    defineProperty(Replacement, 'prototype', { value: Native.prototype, writable: false, enumerable: false, configurable: false });
    setPrototypeOf(Replacement, parent ?? getPrototypeOf(Native));
    // Writable, as the built-in is, so that code assigning `constructor` on objects inheriting from it still works.
    defineProperty(Native.prototype, 'constructor', { value: Replacement, writable: true, enumerable: false, configurable: true });
    seal(scope, name, Replacement);
    return Replacement;
  };
  /** A number argument converted once (as the engine would), so a `valueOf` cannot answer differently later. */
  const numberArg = (value: unknown): number => (value === undefined ? 0 : +(value as number));
  const sizeArg = (value: number): number => {
    const whole = trunc(value);
    return finite(whole) && whole > 0 ? whole : 0;
  };
  /** An options object with only `maxByteLength`, read once. */
  const maxOption = (options: unknown): number | undefined => {
    if (!isObject(options)) return undefined;
    const value = (options as { maxByteLength?: unknown }).maxByteLength;
    return value === undefined ? undefined : +(value as number);
  };
  const bufferConstructor = (Native: Ctor) => (args: ArrayLike<unknown>, newTarget: Ctor): object => {
    const length = numberArg(args[0]);
    const maxLength = maxOption(args[1]);
    const bytes = reserve(mathMax(sizeArg(length), maxLength === undefined ? 0 : sizeArg(maxLength)));
    let buffer: object;
    try {
      const options = maxLength === undefined ? undefined : create(null, { maxByteLength: { value: maxLength, enumerable: true } });
      buffer = construct(Native, options === undefined ? [length] : [length, options], newTarget);
    } catch (error) {
      live -= bytes;
      throw error;
    }
    settle(buffer, bytes);
    return buffer;
  };

  // ArrayBuffer and SharedArrayBuffer.
  replaceConstructor('ArrayBuffer', NativeArrayBuffer as unknown as Ctor, bufferConstructor(NativeArrayBuffer as unknown as Ctor));
  if (NativeShared) replaceConstructor('SharedArrayBuffer', NativeShared as unknown as Ctor, bufferConstructor(NativeShared as unknown as Ctor));
  const sliceBytes = (size: number, start: unknown, end: unknown): number | undefined => {
    if ((start !== undefined && typeof start !== 'number') || (end !== undefined && typeof end !== 'number')) return undefined;
    const edge = (value: number | undefined, fallback: number): number => {
      if (value === undefined) return fallback;
      const whole = trunc(value) || 0;
      return whole < 0 ? mathMax(size + whole, 0) : whole > size ? size : whole;
    };
    return mathMax(edge(end as number | undefined, size) - edge(start as number | undefined, 0), 0);
  };
  for (const [prototype, length] of [[BufferPrototype, bufferLength], [SharedPrototype, sharedLength]] as const) {
    // A copy's size is known beforehand when the bounds are plain numbers; the result is counted either way (it is
    // made through the species constructor, which counts it, unless that resolves to the platform's own).
    for (const key of ['slice', 'sliceToImmutable']) {
      replaceMethod(prototype, key, (native) => function (this: unknown, start?: unknown, end?: unknown) {
        const size = attempt(length, this) as number | undefined;
        if (size !== undefined) {
          const bytes = sliceBytes(size, start, end);
          if (bytes !== undefined) check(bytes);
        }
        const copy = apply(native, this, [start, end]);
        adopt(copy);
        return copy;
      });
    }
  }
  // A transfer moves the source's memory into a new buffer, maybe of another size, and leaves the source empty.
  for (const key of ['transfer', 'transferToFixedLength', 'transferToImmutable']) {
    replaceMethod(BufferPrototype, key, (native) => function (this: unknown, ...args: unknown[]) {
      const size = attempt(bufferLength, this) as number | undefined;
      if (size === undefined) return apply(native, this, args);
      const length = args[0] === undefined ? undefined : +(args[0] as number);
      const resizable = key === 'transfer' && attempt(bufferResizable, this) === true;
      const bytes = mathMax(length === undefined ? size : sizeArg(length), resizable ? attempt(bufferMax, this) as number : 0);
      const held = (unregister ? apply(weakMapGet, tracked, [this]) as number | undefined : 0) ?? 0;
      check(bytes - held);
      const moved = apply(native, this, length === undefined ? [] : [length]) as object;
      releaseDetached(this);
      settle(moved, reserve(bytes));
      return moved;
    });
  }

  // The typed arrays.
  const typedConstructor = (Native: Ctor, element: number) => (args: ArrayLike<unknown>, newTarget: Ctor): object => {
    const first = args[0];
    if (isObject(first) && (attempt(bufferLength, first) !== undefined || attempt(sharedLength, first) !== undefined))
      return construct(Native, args, newTarget); // A view over memory already counted.
    let source: unknown[] | object | undefined;
    let length: number;
    if (!isObject(first)) {
      length = args.length === 0 ? 0 : numberArg(first);
    } else if (attempt(typedLength, first) !== undefined) {
      source = first;
      length = attempt(typedLength, first) as number;
    } else {
      // An iterable or array-like, read once into a plain list so its length cannot change between counting and use.
      // An array-like's length is checked first, so that a huge one is refused before the list is made.
      if (typeof (first as Record<PropertyKey, unknown>)[iteratorKey] !== 'function') check(sizeArg(+((first as { length?: unknown }).length as number)) * element);
      source = apply(arrayFrom, undefined, [first]) as unknown[];
      length = (source as unknown[]).length;
    }
    const bytes = reserve(sizeArg(length) * element);
    let array: Record<number, unknown>;
    try {
      array = construct(Native, source === undefined || isArray(source) ? [length] : [source], newTarget) as Record<number, unknown>;
    } catch (error) {
      live -= bytes;
      throw error;
    }
    settle(attempt(viewBufferOfTyped, array) as object, bytes);
    if (isArray(source)) for (let i = 0; i < length; i++) array[i] = source[i];
    return array;
  };
  const replaced: Record<string, Ctor> = {};
  for (const name of TYPED_ARRAYS) {
    const Native = scope[name] as (Ctor & { BYTES_PER_ELEMENT: number }) | undefined;
    if (!Native) continue;
    replaced[name] = replaceConstructor(name, Native, typedConstructor(Native, Native.BYTES_PER_ELEMENT));
  }
  // Built from text, so the size is known only afterwards; the text itself lives in the heap.
  for (const key of ['fromBase64', 'fromHex']) {
    replaceMethod(replaced.Uint8Array, key, (native) => function (this: unknown, ...args: unknown[]) {
      const array = apply(native, this, args);
      adopt(array);
      return array;
    });
  }
  // Copies: slice, map and filter build their result through the species constructor (counted unless it resolves to
  // the platform's own), the others always through the platform's own. Each result is at most the source's size.
  for (const key of ['slice', 'map', 'filter', 'toReversed', 'toSorted', 'with']) {
    replaceMethod(TypedArrayPrototype, key, (native) => function (this: unknown, ...args: unknown[]) {
      const size = attempt(typedByteLength, this) as number | undefined;
      if (size !== undefined && key === 'slice') {
        const length = attempt(typedLength, this) as number;
        const elements = sliceBytes(length, args[0], args[1]);
        if (elements !== undefined && length > 0) check(elements * (size / length));
      } else if (size !== undefined && key !== 'filter') check(size);
      const copy = apply(native, this, args);
      adopt(copy);
      return copy;
    });
  }

  // structuredClone: the copy is counted as a whole; buffers it transferred are left empty and stop counting.
  replaceMethod(scope, 'structuredClone', (native) => function (this: unknown, ...args: unknown[]) {
    const copy = apply(native, scope, args);
    const transfer = isObject(args[1]) ? (args[1] as { transfer?: unknown }).transfer : undefined;
    if (isObject(transfer)) {
      try {
        const list = apply(arrayFrom, undefined, [transfer]) as unknown[];
        for (let i = 0; i < list.length; i++) releaseDetached(list[i]);
      } catch {
        // Only an early return of memory is lost.
      }
    }
    admit(copy);
    return copy;
  });

  // TextEncoder: at least one byte per UTF-16 unit, at most three.
  replaceMethod((scope.TextEncoder as { prototype?: object } | undefined)?.prototype, 'encode', (native) => function (this: unknown, ...args: unknown[]) {
    if (typeof args[0] === 'string') check(args[0].length);
    const bytes = apply(native, this, args);
    adopt(bytes);
    return bytes;
  });

  // Streams. Chunks the platform produces are counted as they are read; readable byte streams, which move buffers
  // between owners where the budget cannot follow, are not available.
  const NativeReadableStream = scope.ReadableStream as Ctor | undefined;
  const streamGetReader = (NativeReadableStream?.prototype as Proto | undefined)?.getReader as Fn | undefined;
  const ReaderPrototype = (scope.ReadableStreamDefaultReader as { prototype?: Proto } | undefined)?.prototype;
  const readerRead = ReaderPrototype?.read as Fn | undefined;
  const readerCancel = ReaderPrototype?.cancel as Fn | undefined;
  const ControllerPrototype = (scope.ReadableStreamDefaultController as { prototype?: Proto } | undefined)?.prototype;
  const controllerEnqueue = ControllerPrototype?.enqueue as Fn | undefined;
  const controllerClose = ControllerPrototype?.close as Fn | undefined;
  /** A stream with the chunks of `source`, each counted before it is handed on. */
  const countedStream = (source: object): object => {
    const reader = apply(streamGetReader!, source, []);
    const underlying = create(null) as Record<string, unknown>;
    underlying.pull = (controller: object) => new NativePromise<void>((resolve, reject) => {
      then(apply(readerRead!, reader, []), (result) => {
        const { done, value } = result as { done: boolean; value: unknown };
        if (done) {
          apply(controllerClose!, controller, []);
          resolve();
          return;
        }
        try {
          adopt(value);
        } catch (error) {
          apply(readerCancel!, reader, [error]);
          reject(error);
          return;
        }
        apply(controllerEnqueue!, controller, [value]);
        resolve();
      }, reject);
    });
    underlying.cancel = (reason: unknown) => apply(readerCancel!, reader, [reason]);
    const strategy = create(null) as Record<string, unknown>;
    strategy.highWaterMark = 0;
    return construct(NativeReadableStream!, [underlying, strategy]);
  };
  if (NativeReadableStream && streamGetReader && readerRead && readerCancel && controllerEnqueue && controllerClose) {
    const callback = (source: object, value: unknown) =>
      typeof value === 'function' ? (...args: unknown[]) => apply(value as Fn, source, args) : value;
    replaceConstructor('ReadableStream', NativeReadableStream, (args, newTarget) => {
      const source = args[0];
      if (!isObject(source)) return construct(NativeReadableStream, args, newTarget);
      // The members are read once, in the order the platform reads them, and the platform gets a copy.
      const { autoAllocateChunkSize, cancel, pull, start, type } = source as Record<string, unknown>;
      if (type !== undefined && `${type as string}` === 'bytes')
        throw new TypeErrorCtor('Readable byte streams are not available to extensions.');
      const copy = create(null) as Record<string, unknown>;
      copy.autoAllocateChunkSize = autoAllocateChunkSize;
      copy.cancel = callback(source, cancel);
      copy.pull = callback(source, pull);
      copy.start = callback(source, start);
      copy.type = type;
      return construct(NativeReadableStream, args.length > 1 ? [copy, args[1]] : [copy], newTarget);
    });
    for (const name of ['CompressionStream', 'DecompressionStream', 'TextEncoderStream']) {
      const prototype = (scope[name] as { prototype?: object } | undefined)?.prototype;
      const nativeReadable = getter(prototype, 'readable');
      if (!prototype || !nativeReadable) continue;
      const wrapped = new WeakMap<object, object>();
      defineProperty(prototype, 'readable', {
        get: function readable(this: object) {
          const native = apply(nativeReadable, this, []) as object;
          let stream = apply(weakMapGet, wrapped, [this]) as object | undefined;
          if (!stream) {
            stream = countedStream(native);
            apply(weakMapSet, wrapped, [this, stream]);
          }
          return stream;
        },
        enumerable: true, configurable: false,
      });
    }
  }

  // Blobs and Files: counted by size when made (the parts are copied in), sliced, or read.
  if (NativeBlob && blobSize) {
    const partsBytes = (parts: unknown[]): number => {
      let total = 0;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (typeof part === 'string') total += part.length;
        else if (isObject(part)) {
          const view = (attempt(typedByteLength, part) ?? attempt(dataViewByteLength, part)) as number | undefined;
          total += view ?? sizeOf(part) ?? 0;
        }
      }
      return total;
    };
    /** An iterable over `list` that ignores later changes to the built-in iterators. */
    const iterableOf = (list: unknown[]): object => {
      let i = 0;
      const iterator = create(null) as Record<string, unknown>;
      iterator.next = () => {
        const step = create(null) as Record<string, unknown>;
        step.done = i >= list.length;
        step.value = step.done ? undefined : list[i++];
        return step;
      };
      const iterable = create(null) as Record<PropertyKey, unknown>;
      iterable[iteratorKey] = () => iterator;
      return iterable;
    };
    const blobConstructor = (Native: Ctor) => (args: ArrayLike<unknown>, newTarget: Ctor): object => {
      const parts = args[0];
      let blob: object;
      if (isObject(parts) && typeof (parts as Record<PropertyKey, unknown>)[iteratorKey] === 'function') {
        const list = apply(arrayFrom, undefined, [parts]) as unknown[];
        check(partsBytes(list));
        blob = construct(Native, args.length >= 3 ? [iterableOf(list), args[1], args[2]] : args.length === 2 ? [iterableOf(list), args[1]] : [iterableOf(list)], newTarget);
      } else {
        blob = construct(Native, args, newTarget);
      }
      settle(blob, 0);
      return blob;
    };
    const Blob = replaceConstructor('Blob', NativeBlob, blobConstructor(NativeBlob));
    const NativeFile = scope.File as Ctor | undefined;
    if (NativeFile) replaceConstructor('File', NativeFile, blobConstructor(NativeFile), Blob);
    const BlobPrototype = NativeBlob.prototype as unknown as Proto;
    replaceMethod(BlobPrototype, 'slice', (native) => function (this: unknown, ...args: unknown[]) {
      const part = apply(native, this, args) as object;
      settle(part, 0);
      return part;
    });
    for (const key of ['arrayBuffer', 'bytes']) {
      replaceMethod(BlobPrototype, key, (native) => function (this: unknown) {
        const size = attempt(blobSize, this) as number | undefined;
        if (size === undefined) return apply(native, this, []);
        let bytes: number;
        try {
          bytes = reserve(size);
        } catch (error) {
          return apply(promiseReject, NativePromise, [error]);
        }
        return then(apply(native, this, []), (result) => {
          settle((bufferOfView(result) ?? result) as object, bytes);
          return result;
        }, (error) => {
          live -= bytes;
          throw error;
        });
      });
    }
    if (NativeReadableStream && streamGetReader && readerRead)
      replaceMethod(BlobPrototype, 'stream', (native) => function (this: unknown) { return countedStream(apply(native, this, []) as object); });

    // A FormData keeps the Blobs put into it alive.
    for (const key of ['append', 'set']) {
      replaceMethod((scope.FormData as { prototype?: object } | undefined)?.prototype, key, (native) => function (this: unknown, ...args: unknown[]) {
        const size = attempt(blobSize, args[1]) as number | undefined;
        const bytes = size === undefined ? 0 : reserve(size);
        try {
          apply(native, this, args);
        } catch (error) {
          live -= bytes;
          throw error;
        }
        if (isObject(this)) hold(this, bytes);
        return undefined;
      });
    }

    // File readers: the reader holds its result, and the result is counted again once handed out.
    for (const name of ['FileReaderSync', 'FileReader']) {
      const prototype = (scope[name] as { prototype?: object } | undefined)?.prototype;
      replaceMethod(prototype, 'readAsArrayBuffer', (native) => function (this: unknown, ...args: unknown[]) {
        const size = attempt(blobSize, args[0]) as number | undefined;
        const bytes = size === undefined ? 0 : reserve(size);
        let result: unknown;
        try {
          result = apply(native, this, args);
        } catch (error) {
          live -= bytes;
          throw error;
        }
        if (name === 'FileReaderSync') settle(result as object, bytes);
        else if (isObject(this)) hold(this, bytes);
        return result;
      });
      const nativeResult = getter(prototype, 'result');
      if (prototype && nativeResult)
        defineProperty(prototype, 'result', {
          get: function result(this: unknown) {
            const value = apply(nativeResult, this, []);
            adopt(value);
            return value;
          },
          enumerable: true, configurable: false,
        });
    }
  }

  // Web Crypto: results are counted; keys by the key material they hold.
  const subtle = (scope.SubtleCrypto as { prototype?: object } | undefined)?.prototype;
  const keyAlgorithm = getter((scope.CryptoKey as { prototype?: object } | undefined)?.prototype, 'algorithm');
  const keyBytes = (key: unknown): void => {
    const algorithm = attempt(keyAlgorithm, key) as { length?: unknown; modulusLength?: unknown } | undefined;
    if (!algorithm || !isObject(key)) return;
    const bits = typeof algorithm.length === 'number' ? algorithm.length : typeof algorithm.modulusLength === 'number' ? algorithm.modulusLength : 0;
    const bytes = reserve(bits / 8);
    hold(key, bytes);
  };
  /** Where each method takes the algorithm of the key it makes, whose length (in bits) is checked beforehand. */
  const keyAlgorithmArg: Record<string, number> = { importKey: 2, generateKey: 0, deriveKey: 2, unwrapKey: 4 };
  for (const key of ['encrypt', 'decrypt', 'sign', 'digest', 'deriveBits', 'exportKey', 'wrapKey', 'importKey', 'generateKey', 'deriveKey', 'unwrapKey']) {
    replaceMethod(subtle, key, (native) => function (this: unknown, ...args: unknown[]) {
      try {
        const algorithm = hasOwn(keyAlgorithmArg, key) ? args[keyAlgorithmArg[key]!] : undefined;
        const bits = isObject(algorithm) ? (algorithm as { length?: unknown }).length : undefined;
        if (typeof bits === 'number') check(bits / 8);
        if (key === 'importKey' && isObject(args[1])) check(sizeOf(bufferOfView(args[1]) ?? args[1]) ?? 0);
      } catch (error) {
        return apply(promiseReject, NativePromise, [error]);
      }
      return then(apply(native, this, args), (result) => {
        admit(result);
        if (attempt(keyAlgorithm, result) !== undefined) keyBytes(result);
        else if (isObject(result)) {
          keyBytes((result as { publicKey?: unknown }).publicKey);
          keyBytes((result as { privateKey?: unknown }).privateKey);
        }
        return result;
      }, (error) => { throw error; });
    });
  }

  // What cannot be counted is removed, wherever the scope's prototype chain holds it.
  const remove = (target: object, name: string): void => {
    for (let level: object | null = target; level; level = getPrototypeOf(level))
      if (hasOwn(level, name)) seal(level, name, undefined);
  };
  for (const name of REMOVED_GLOBALS) if (name in scope) remove(scope, name);
  const performancePrototype = (scope.Performance as { prototype?: object } | undefined)?.prototype;
  if (performancePrototype) for (const name of ['mark', 'measure']) remove(performancePrototype, name);
  const navigatorPrototype = (scope.WorkerNavigator as { prototype?: object } | undefined)?.prototype;
  if (navigatorPrototype) remove(navigatorPrototype, 'gpu');

  return { live: () => live, admit };
}
