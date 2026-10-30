// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { createContext, useContext } from 'react';
import type { AppInstance } from './bootstrap';

export const AppContext = createContext<AppInstance | null>(null);

export function useApp(): AppInstance {
  const app = useContext(AppContext);
  if (!app) throw new Error('useApp must be used inside <App>');
  return app;
}
