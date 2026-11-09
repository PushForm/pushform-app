// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { CommonsCommerce, type CommonsPublicPurchase } from '@pushform/cloud';
import { useEffect, useMemo, useState } from 'react';
import type { CommonsAccount } from './account';
import { recordPurchaseClick } from './purchaseClicks';

export function WhereToBuy({
  modelId,
  account,
}: {
  modelId: string;
  account: CommonsAccount | null;
}) {
  const api = useMemo(() => (account ? new CommonsCommerce(account.client) : null), [account]);
  const [sources, setSources] = useState<CommonsPublicPurchase[] | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setSources(null);
    setError(false);
    if (api)
      void api.sources(modelId, controller.signal).then(
        (value) => {
          if (!controller.signal.aborted) setSources(value);
        },
        () => {
          if (!controller.signal.aborted) setError(true);
        },
      );
    return () => controller.abort();
  }, [api, modelId, attempt]);
  if (!api || (!error && !sources?.length)) return null;
  return (
    <section className="where-to-buy" aria-label="Where to buy">
      <h2>Where to buy</h2>
      {error ? (
        <p>
          Purchase options could not be loaded.{' '}
          <button onClick={() => setAttempt((value) => value + 1)}>Try again</button>
        </p>
      ) : (
        <>
          <p className="purchase-intro">
            Products with this general shape. Manufacturers and details may differ from the model.
            Check dimensions before buying.
          </p>
          <ul>
            {sources!.map((source) => (
              <li key={source.id}>
                <div>
                  <h3>{source.productTitle}</h3>
                  {(source.variant || source.finish || source.packQuantity) && (
                    <p>
                      {[
                        source.variant,
                        !source.variant ? source.finish : null,
                        source.packQuantity ? `${source.packQuantity} pack` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  )}
                  <p className="purchase-marketplace">
                    {source.marketplace.name} · {source.marketplace.country} ·{' '}
                    {source.relationship === 'reference' ? 'Reference product' : 'Similar option'}
                  </p>
                  <details>
                    <summary>Product details</summary>
                    <dl>
                      {source.brand && (
                        <>
                          <dt>Brand</dt>
                          <dd>{source.brand}</dd>
                        </>
                      )}
                      {source.manufacturer && (
                        <>
                          <dt>Manufacturer</dt>
                          <dd>{source.manufacturer}</dd>
                        </>
                      )}
                      {source.manufacturerPartNumber && (
                        <>
                          <dt>Part number</dt>
                          <dd>{source.manufacturerPartNumber}</dd>
                        </>
                      )}
                      {source.marketplaceProductId && (
                        <>
                          <dt>{source.marketplace.identifierLabel}</dt>
                          <dd>{source.marketplaceProductId}</dd>
                        </>
                      )}
                      {source.seller && (
                        <>
                          <dt>Seller</dt>
                          <dd>{source.seller}</dd>
                        </>
                      )}
                      {source.sellerSku && (
                        <>
                          <dt>Seller SKU</dt>
                          <dd>{source.sellerSku}</dd>
                        </>
                      )}
                      {source.gtin && (
                        <>
                          <dt>GTIN / UPC</dt>
                          <dd>{source.gtin}</dd>
                        </>
                      )}
                      {source.finish && (
                        <>
                          <dt>Finish</dt>
                          <dd>{source.finish}</dd>
                        </>
                      )}
                      {source.material && (
                        <>
                          <dt>Material</dt>
                          <dd>{source.material}</dd>
                        </>
                      )}
                      {source.dimensions && (
                        <>
                          <dt>Dimensions</dt>
                          <dd>{source.dimensions}</dd>
                        </>
                      )}
                      {source.checkedAt && (
                        <>
                          <dt>Last checked</dt>
                          <dd>{new Date(source.checkedAt).toLocaleDateString()}</dd>
                        </>
                      )}
                    </dl>
                    {source.availability !== 'unknown' && source.checkedAt && (
                      <p className="purchase-marketplace">
                        {source.availability === 'in_stock'
                          ? 'Listed in stock'
                          : source.availability === 'out_of_stock'
                            ? 'Listed out of stock'
                            : 'Listed discontinued'}{' '}
                        when checked. Availability may change.
                      </p>
                    )}
                  </details>
                </div>
                <div className="purchase-action">
                  <a
                    href={source.outboundUrl}
                    target="_blank"
                    rel={source.affiliate ? 'sponsored noopener' : 'noopener'}
                    onClick={(event) => {
                      if (!event.defaultPrevented) recordPurchaseClick(source);
                    }}
                    onAuxClick={(event) => {
                      if (event.button === 1 && !event.defaultPrevented)
                        recordPurchaseClick(source);
                    }}
                  >
                    View on {source.marketplace.name} ↗
                  </a>
                  {source.affiliate && source.disclosure && (
                    <p className="purchase-disclosure">{source.disclosure}</p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
