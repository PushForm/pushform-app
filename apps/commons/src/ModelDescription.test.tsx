// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ModelDescription } from './ModelDescription';
afterEach(cleanup);
it('preserves plain text without turning a contributor description into purchase links', () => {
  render(
    <ModelDescription
      text={'Reference model.\nhttps://www.amazon.com/dp/B07SM751SC\nDimensions approximate.'}
    />,
  );
  expect(screen.queryByRole('link')).toBeNull();
  expect(screen.getByText(/Dimensions approximate/)).toBeDefined();
});
it('leaves HTML and unsafe URLs inert', () => {
  const { container } = render(
    <ModelDescription
      text={'<img src=x onerror=alert(1)> javascript:alert(1) https://user:pass@example.com/.'}
    />,
  );
  expect(container.querySelector('img')).toBeNull();
  expect(screen.queryByRole('link')).toBeNull();
});
