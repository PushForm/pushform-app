// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { PublishPage } from './PublishPage';
import { configuredCommonsAccount } from './account';
import { restoreCommonsReturnRoute } from './CommonsAccess';
import { configuredCatalogLoader } from './catalog';
import './styles.css';

const account=configuredCommonsAccount(import.meta.env);
restoreCommonsReturnRoute();
const root = document.getElementById('root');
if (!root) throw new Error('Missing application root.');
createRoot(root).render(<StrictMode><App account={account} loadCatalog={configuredCatalogLoader(import.meta.env)} filesUrl={import.meta.env.VITE_COMMONS_ASSETS_URL} editorUrl={import.meta.env.VITE_PUSHFORM_EDITOR_URL} publishPage={account?<PublishPage account={account} filesUrl={import.meta.env.VITE_COMMONS_ASSETS_URL}/>:undefined} /></StrictMode>);
