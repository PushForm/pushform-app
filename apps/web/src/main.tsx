// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import './zodConfig';
import { rootErrorHandlers } from './sentry';
import { createRoot } from 'react-dom/client';
import { App } from '@pushform/ui';
import { cloudSession, cloudFiles, cloudProfiles, cloudAccount, cloudUsage, requestsConfig } from './cloud';
import { buildInfo } from './buildInfo';
import workerSource, { computeSource } from 'virtual:pushform-extension-worker';
import './styles.css';

// The desktop shell runs extensions in its own isolated runtime, which is not built yet; only the browser offers them.
const extensionRuntime = '__TAURI_INTERNALS__' in window ? undefined : { workerSource, computeSource };

createRoot(document.getElementById('root')!, rootErrorHandlers).render(<App cloud={cloudSession} cloudFiles={cloudFiles} profiles={cloudProfiles} account={cloudAccount} usage={cloudUsage} buildInfo={buildInfo} requests={requestsConfig} extensionRuntime={extensionRuntime} />);
