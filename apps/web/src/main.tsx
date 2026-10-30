// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import './zodConfig';
import { rootErrorHandlers } from './sentry';
import { createRoot } from 'react-dom/client';
import { App } from '@pushform/ui';
import { cloudSession, cloudFiles, cloudProfiles, cloudAccount, cloudUsage, requestsConfig } from './cloud';
import { buildInfo } from './buildInfo';
import './styles.css';

createRoot(document.getElementById('root')!, rootErrorHandlers).render(<App cloud={cloudSession} cloudFiles={cloudFiles} profiles={cloudProfiles} account={cloudAccount} usage={cloudUsage} buildInfo={buildInfo} requests={requestsConfig} />);
