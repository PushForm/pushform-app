// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors

/**
 * One end of the channel between the host and an extension runtime. In the browser this wraps a `MessagePort`
 * handed over by the runtime bootstrap; tests use both ends of a `MessageChannel`.
 */
export interface RuntimePort {
  post(message: unknown): void;
  /** Starts delivering messages to `handler`; returns a function that stops delivery. */
  listen(handler: (message: unknown) => void): () => void;
  close(): void;
}

/** A `RuntimePort` over a `MessagePort`. Messages are structured-cloned, so no live object crosses it. */
export function messagePortTransport(port: MessagePort): RuntimePort {
  return {
    post: (message) => port.postMessage(message),
    listen(handler) {
      const onMessage = (event: MessageEvent) => handler(event.data);
      port.addEventListener('message', onMessage);
      port.start();
      return () => port.removeEventListener('message', onMessage);
    },
    close: () => port.close(),
  };
}
