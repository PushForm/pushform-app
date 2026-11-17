// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// The public PushForm documentation site, published at docs.pushform.io.
// Pages live in src/content/docs. The in-app help guides in ../docs/help are a separate source and are not built here.
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://docs.pushform.io',
  trailingSlash: 'ignore',
  integrations: [
    starlight({
      title: 'PushForm Docs',
      description: 'Guides for PushForm, push/pull 2D and 3D modeling for woodworkers, carpenters, architects and landscapers.',
      logo: { src: './src/assets/pf-logo-mark.svg', alt: 'PushForm' },
      favicon: '/favicon.svg',
      customCss: ['./src/styles/pushform.css'],
      social: [
        { icon: 'github', label: 'PushForm on GitHub', href: 'https://github.com/PushForm/pushform-app' },
      ],
      editLink: { baseUrl: 'https://github.com/PushForm/pushform-app/edit/main/docs/' },
      sidebar: [
        { label: 'Getting started', items: [{ autogenerate: { directory: 'getting-started' } }] },
      ],
    }),
  ],
});
