// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import './zodConfig';
import { rootErrorHandlers } from './sentry';
import { createRoot } from 'react-dom/client';
import { App } from '@pushform/ui';
import { cloudSession, cloudCommons, cloudFiles, cloudProfiles, cloudAccount, cloudBilling, cloudUsage, cloudStaff, requestsConfig, commonsIntent, clearCommonsIntent } from './cloud';
import { buildInfo } from './buildInfo';
import { productUsageForOwner } from './productAnalytics';
import workerSource, { computeSource } from 'virtual:pushform-extension-worker';
import './styles.css';

// The desktop shell runs extensions in its own isolated runtime, which is not built yet; only the browser offers them.
const extensionRuntime = '__TAURI_INTERNALS__' in window ? undefined : { workerSource, computeSource };
// Extensions are offered to PushForm staff until the first official extension ships; local development always has them.
const extensionsStaff = import.meta.env.DEV ? { isStaff: async () => true } : cloudStaff;

const productUsage = productUsageForOwner(cloudUsage, cloudSession, cloudProfiles, {
  token: import.meta.env.VITE_POSTHOG_TOKEN as string | undefined, production: import.meta.env.PROD,
  hostname: window.location.hostname, desktop: '__TAURI_INTERNALS__' in window,
  privacy: () => ({ dnt: navigator.doNotTrack, windowDnt: (window as Window & { doNotTrack?: string }).doNotTrack,
    gpc: (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl }),
  userAgent: () => navigator.userAgent,
});

createRoot(document.getElementById('root')!, rootErrorHandlers).render(<App commons={{ account: cloudCommons, intent: commonsIntent, filesUrl: import.meta.env.VITE_COMMONS_ASSETS_URL, handled: clearCommonsIntent }} cloud={cloudSession} cloudFiles={cloudFiles} profiles={cloudProfiles} account={cloudAccount} billing={cloudBilling} usage={productUsage} buildInfo={buildInfo} requests={requestsConfig} extensionRuntime={extensionRuntime} staff={extensionsStaff} />);
