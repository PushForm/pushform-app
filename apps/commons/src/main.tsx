// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { configuredCatalogLoader } from './catalog';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root.');
createRoot(root).render(<StrictMode><App loadCatalog={configuredCatalogLoader(import.meta.env)} filesUrl={import.meta.env.VITE_COMMONS_ASSETS_URL} /></StrictMode>);
