// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { commonsPublicPurchaseSchema } from '@pushform/cloud';
import { WhereToBuy } from './WhereToBuy';
import type { CommonsAccount } from './account';
import { recordPurchaseClick } from './purchaseClicks';
vi.mock('./purchaseClicks', () => ({ recordPurchaseClick: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const source = (affiliate = false) =>
  commonsPublicPurchaseSchema.parse({
    id: affiliate ? '22222222-2222-4222-8222-222222222222' : '11111111-1111-4111-8111-111111111111',
    version: 2,
    destinationVersion: 'a'.repeat(32),
    productTitle: affiliate ? 'Other manufacturer pull' : 'Round cabinet pull',
    marketplace: { id: 'amazon-us', name: 'Amazon', country: 'US', identifierLabel: 'ASIN' },
    marketplaceProductId: 'B073TWK9RC',
    manufacturer: affiliate ? 'Another Maker' : 'Example Manufacturer',
    manufacturerPartNumber: 'P-42',
    purchaseUrl: 'https://www.amazon.com/dp/B073TWK9RC',
    outboundUrl: 'https://www.amazon.com/dp/B073TWK9RC' + (affiliate ? '?tag=example-20' : ''),
    affiliate,
    disclosure: affiliate ? 'PushForm may earn a commission.' : null,
    relationship: 'similar',
    availability: 'unknown',
    packQuantity: 5,
  });
function account(data: unknown) {
  const rpc = vi.fn(() => ({ abortSignal: () => Promise.resolve({ data, error: null }) }));
  return { value: { client: { rpc } } as unknown as CommonsAccount, rpc };
}
it('shows multiple manufacturers as purchase options with identifiers in their own details and a direct visible destination', async () => {
  const a = account([source(), source(true)]);
  render(<WhereToBuy account={a.value} modelId="round-pull" />);
  await screen.findByRole('heading', { name: 'Where to buy' });
  expect(screen.getByText('Example Manufacturer')).toBeTruthy();
  expect(screen.getByText('Another Maker')).toBeTruthy();
  expect(screen.getAllByText('P-42')).toHaveLength(2);
  const links = screen.getAllByRole('link', { name: 'View on Amazon ↗' });
  expect(links[0]!.getAttribute('href')).toBe(source().purchaseUrl);
  expect(links[1]!.getAttribute('rel')).toBe('sponsored noopener');
  expect(screen.getByText('PushForm may earn a commission.')).toBeTruthy();
  expect(recordPurchaseClick).not.toHaveBeenCalled();
  fireEvent.click(links[0]!);
  expect(recordPurchaseClick).toHaveBeenCalledWith(source());
  fireEvent(links[1]!, new MouseEvent('auxclick', { bubbles: true, button: 1 }));
  expect(recordPurchaseClick).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('button', { name: /Edit|Add purchase/ })).toBeNull();
});
it('omits the section for models without purchase sources and does not fetch without configured access', async () => {
  const a = account([]);
  const view = render(<WhereToBuy account={a.value} modelId="round-pull" />);
  await waitFor(() => expect(a.rpc).toHaveBeenCalled());
  expect(screen.queryByRole('heading', { name: 'Where to buy' })).toBeNull();
  view.rerender(<WhereToBuy account={null} modelId="round-pull" />);
  expect(a.rpc).toHaveBeenCalledTimes(1);
});
