// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
export interface Toast {
  readonly id: number;
  readonly message: string;
  readonly durationMs: number;
  readonly revision: number;
}

/** Small external store: UI and command handlers can notify without owning a dialog. */
export function createToastStore() {
  let items: readonly Toast[] = [];
  let serial = 0;
  const listeners = new Set<() => void>();
  const publish = (next: readonly Toast[]): void => {
    items = next;
    listeners.forEach(listener => listener());
  };
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => items,
    show(message: string, durationMs = 5000): number {
      const existing = items.find(item => item.message === message);
      const revision = ++serial;
      const toast: Toast = { id: existing?.id ?? revision, message, revision,
        durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 5000 };
      // Repeated notifications refresh in place rather than filling the screen.
      publish(existing ? items.map(item => item.id === existing.id ? toast : item) : [...items, toast].slice(-3));
      return toast.id;
    },
    dismiss(id: number): void {
      if (items.some(item => item.id === id)) publish(items.filter(item => item.id !== id));
    },
    clear(): void { if (items.length) publish([]); },
  };
}

export type ToastStore = ReturnType<typeof createToastStore>;
export const toasts = createToastStore();
export const showToast = toasts.show;
