// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import './zodConfig';
import { followCampaign } from '@pushform/cloud';
import { rootErrorHandlers } from './sentry';
import { createRoot } from 'react-dom/client';
import { App } from '@pushform/ui';
import { cloudSession, cloudCommons, cloudFiles, cloudProfiles, cloudAccount, cloudBilling, cloudUsage, cloudStaff, cloudCampaign, cloudActivity, campaignToken, clearCampaign, requestsConfig, commonsIntent, clearCommonsIntent } from './cloud';
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

const stopCampaign = followCampaign(cloudSession, cloudProfiles, cloudCampaign, campaignToken, clearCampaign,
  () => import.meta.env.PROD && window.location.hostname === 'app.pushform.io' && !('__TAURI_INTERNALS__' in window)
    && !(navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl && navigator.doNotTrack !== '1' && (window as Window & { doNotTrack?: string }).doNotTrack !== '1');
if (import.meta.hot) import.meta.hot.dispose(stopCampaign);

const activityByOwner = new Map<string, ReturnType<NonNullable<typeof cloudActivity>['forOwner']>>();
const activity = cloudActivity ? (owner: string) => {
  let sink = activityByOwner.get(owner);
  if (!sink) {
    let storage: Storage | null = null;
    try { storage = window.localStorage; } catch { /* Optional persistence. */ }
    sink = cloudActivity!.forOwner(owner, () => import.meta.env.PROD && ('__TAURI_INTERNALS__' in window || window.location.hostname === 'app.pushform.io')
      && !(navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl && navigator.doNotTrack !== '1'
      && (window as Window & { doNotTrack?: string }).doNotTrack !== '1', storage);
    activityByOwner.set(owner, sink);
    window.addEventListener('pagehide', () => { void sink!.flush(); });
    window.addEventListener('online', () => { void sink!.flush(); });
    void sink.flush();
  }
  return sink;
} : undefined;

createRoot(document.getElementById('root')!, rootErrorHandlers).render(<App commons={{ account: cloudCommons, intent: commonsIntent, filesUrl: import.meta.env.VITE_COMMONS_ASSETS_URL, handled: clearCommonsIntent }} cloud={cloudSession} cloudFiles={cloudFiles} profiles={cloudProfiles} account={cloudAccount} billing={cloudBilling} usage={productUsage} activity={activity} buildInfo={buildInfo} requests={requestsConfig} extensionRuntime={extensionRuntime} staff={extensionsStaff} />);
