// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { LayoutRecoveryStore } from '@pushform/io';

/** Keep account A's cached documents/recovery out of account B's workspace on shared browsers. */
export function accountSessionStorage(ownerId: string, storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const prefix = `pushform:account:${ownerId}:`;
  return {
    getItem: key => storage.getItem(prefix + key),
    setItem: (key, value) => storage.setItem(prefix + key, value),
    removeItem: key => storage.removeItem(prefix + key),
  };
}
export function accountRecoveryStore(ownerId: string, storage: LayoutRecoveryStore | null): LayoutRecoveryStore | null {
  if (!storage) return null;
  const prefix = `account:${ownerId}:`;
  return {
    list: async () => (await storage.list(prefix)).filter(record => record.id.startsWith(prefix))
      .map(record => ({ ...record, id: record.id.slice(prefix.length) })),
    read: async id => {
      const record = await storage.read(prefix + id);
      return record?.id === prefix + id ? { ...record, id } : undefined;
    },
    put: record => storage.put({ ...record, id: prefix + record.id }),
    delete: id => storage.delete(prefix + id),
  };
}
