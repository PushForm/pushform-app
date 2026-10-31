// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createCatalogLoader } from './catalog';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root.');
createRoot(root).render(<StrictMode><App loadCatalog={createCatalogLoader(import.meta.env.VITE_COMMONS_CATALOG_URL)} /></StrictMode>);
