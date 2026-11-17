// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { SiteFooter } from './SiteFooter';

afterEach(cleanup);

const profiles = [
  ['Discord', 'https://discord.gg/HX9YVcqzNB'],
  ['GitHub', 'https://github.com/PushForm'],
  ['X', 'https://x.com/pushformio'],
  ['Reddit', 'https://www.reddit.com/user/PushForm/'],
];

it.each([false, true])('links to PushForm social profiles after the site links (floating: %s)', docked => {
  render(<SiteFooter docked={docked} />);
  const footer = screen.getByRole('contentinfo');
  expect(footer.textContent).toContain('Good projects start with shared ideas.');
  expect(within(footer).getAllByRole('link').map(link => link.textContent || link.getAttribute('aria-label')))
    .toEqual(['PushForm', 'Terms', 'Privacy', ...profiles.map(([name]) => name)]);
  const social = within(footer).getByRole('list', { name: 'PushForm on social media' });
  const links = within(social).getAllByRole('link');
  expect(links.map(link => [link.getAttribute('aria-label'), link.getAttribute('href')])).toEqual(profiles);
  for (const link of links) {
    expect(link.getAttribute('title')).toBe(link.getAttribute('aria-label'));
    expect(link.getAttribute('target')).toBeNull();
    expect(link.getAttribute('rel')).toBe('noopener');
    expect(link.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  }
});
