// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef, type ReactNode } from 'react';
import type { CatalogFilters } from './catalog';

interface Props {
  filters: CatalogFilters;
  update(patch: Partial<CatalogFilters>): void;
  categories: string[];
  licenses: string[];
  collections: boolean;
  children: ReactNode;
  onDockChange(docked: boolean): void;
}
function Fields({ filters, update, categories, licenses, collections }: Omit<Props, 'children' | 'onDockChange'>) {
  const options = (values: string[]) => [...new Set(values)].sort().map(value => <option key={value} value={value}>{value}</option>);
  return <div className="filters" role="search" aria-label={collections ? 'Search collections' : 'Search models'}>
    <label className="search-field"><span>{collections ? 'Search collections' : 'Search models'}</span><input type="search" maxLength={200} placeholder={collections ? 'Try workshop essentials or outdoor projects…' : 'Try a chair, hinge or garden bench…'} value={filters.query} onChange={event => update({ query: event.target.value })} /></label>
    <label><span>Category</span><select value={filters.category} onChange={event => update({ category: event.target.value })}><option value="">All categories</option>{options(categories)}</select></label>
    <label><span>License</span><select value={filters.license} onChange={event => update({ license: event.target.value })}><option value="">All licenses</option>{options(licenses)}</select></label>
    <label className="commercial"><input type="checkbox" checked={filters.commercial} onChange={event => update({ commercial: event.target.checked })} />Commercial use permitted</label>
  </div>;
}

export function BrowseFilters({ children, onDockChange, ...props }: Props) {
  const marker = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = marker.current;
    if (!element) return;
    const measure = () => { const rect = element.getBoundingClientRect(); onDockChange(rect.height > 0 && rect.bottom <= 0); };
    measure();
    if (typeof IntersectionObserver !== 'undefined') {
      const observer = new IntersectionObserver(([entry]) => {
        if (entry) onDockChange(!entry.isIntersecting && entry.boundingClientRect.bottom <= 0);
      });
      observer.observe(element);
      return () => { observer.disconnect(); onDockChange(false); };
    }
    window.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => { window.removeEventListener('scroll', measure); window.removeEventListener('resize', measure); onDockChange(false); };
  }, [onDockChange]);
  return <>
    <div ref={marker} className="browse-filter-marker" aria-hidden="true" />
    <div className="browse-sticky-filters"><Fields {...props} /></div>
    {children}
  </>;
}
