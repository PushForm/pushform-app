// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { guidanceHighlightSchema, guidanceListSchema, guidanceSidebarSchema } from '@pushform/requests-core';
import type { DocumentToolOutcome } from '@pushform/requests-ui';
import type { DocumentSession, DocumentTab } from './session';

export interface GuidanceTarget { id: string; label: string; surface?: 'toolbar' | 'menu' | 'object' | 'tab' | 'sidebar'; route?: string; dropdown?: string; action?: string; enabled?: boolean; active?: boolean; helpQuery?: string }
type Target = GuidanceTarget;
interface Provider { root: HTMLElement; targets: readonly Target[]; reveal(ids: readonly string[]): void }
// Host-private closures: no DOM events, globals, command IDs or extension capability endpoints.
const providers = new Set<Provider>();
export function registerGuidanceTargets(provider: Provider): () => void {
  providers.add(provider);
  return () => { providers.delete(provider); };
}
const available = (element: HTMLElement): boolean => element.isConnected && !element.closest('[hidden], [inert]');
const outcome = (value: unknown, isError = false): DocumentToolOutcome => ({ content: JSON.stringify(value), isError });
const settle = (): Promise<void> => new Promise(resolve => requestAnimationFrame(() => resolve()));

/** One conversation turn, bound to its sending tab and AbortSignal, never exported from the UI package. */
export function guidanceFor(session: DocumentSession, tab: DocumentTab, openPanel: (panel: 'objects' | 'requests') => void) {
  const valid = (): boolean => session.tabs.includes(tab) && session.active === tab;
  const elements = (): HTMLElement[] => {
    // Secondary/contextual toolbars also use ordinary native buttons.
    for (const button of document.querySelectorAll<HTMLElement>('.pf-toolbar button, .pf-layout-text-toolbar button, [role="toolbar"] button')) {
      const label = button.getAttribute('aria-label') ?? button.title ?? button.textContent?.trim();
      if (!button.hasAttribute('data-guidance-skip') && !button.dataset['guidanceId'] && label) button.dataset['guidanceId'] = `control:${label}`;
    }
    return [...document.querySelectorAll<HTMLElement>('[data-guidance-id]')].filter(element => available(element) && !element.hasAttribute('data-guidance-skip'));
  };
  const activeProviders = (): Provider[] => [...providers].filter(provider => available(provider.root));
  return async (name: string, input: unknown, signal?: AbortSignal, cueId?: string): Promise<DocumentToolOutcome> => {
    if (!valid() || signal?.aborted) return outcome({ status: 'cancelled', tabId: tab.id });
    if (name === 'ui_open_sidebar') {
      const parsed = guidanceSidebarSchema.safeParse(input);
      if (!parsed.success) return outcome({ status: 'invalid', message: parsed.error.message }, true);
      openPanel(parsed.data.panel);
      return outcome({ status: 'opened', panel: parsed.data.panel });
    }
    if (name === 'ui_list_targets') {
      const parsed = guidanceListSchema.safeParse(input);
      if (!parsed.success) return outcome({ status: 'invalid', message: parsed.error.message }, true);
      if (!valid() || signal?.aborted) return outcome({ status: 'cancelled', tabId: tab.id });
      const targets = new Map<string, Target>();
      for (const element of elements()) {
        const id = element.dataset['guidanceId']!;
        const label = element.getAttribute('aria-label') || element.title || element.textContent?.trim() || id;
        const group = element.closest('[role="group"][aria-label]')?.getAttribute('aria-label');
        const surface = id.startsWith('object:') ? 'object' : id.startsWith('menu:') ? 'menu' : id.startsWith('tab:') || id.startsWith('scene:') ? 'tab' : id.startsWith('sidebar:') ? 'sidebar' : 'toolbar';
        targets.set(id, { id, label, surface,
          route: element.dataset['guidanceRoute'] ?? [surface === 'toolbar' ? 'Toolbar' : surface, group, label].filter(Boolean).join(' > '),
          action: element.dataset['guidanceAction'] ?? `${tab.type}:${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
          enabled: !element.matches(':disabled') && element.getAttribute('aria-disabled') !== 'true',
          active: element.getAttribute('aria-pressed') === 'true' || element.getAttribute('aria-current') === 'page',
          helpQuery: `${tab.type === 'model' ? 'Modeling' : 'Layout'} ${label}` });
      }
      for (const provider of activeProviders()) for (const target of provider.targets) {
        targets.set(target.id, { ...targets.get(target.id), ...target, helpQuery: `${tab.type === 'model' ? 'Modeling' : 'Layout'} ${target.label}` });
      }
      const query = parsed.data.query?.toLowerCase() ?? '';
      const matching = [...targets.values()].filter(target => `${target.id} ${target.label}`.toLowerCase().includes(query));
      const end = parsed.data.offset + parsed.data.limit;
      return outcome({ tabId: tab.id, editor: tab.type, activeTool: document.querySelector('.pf-toolbar [aria-pressed="true"]')?.getAttribute('aria-label') ?? null, objectBrowserVisible: !!document.querySelector('.pf-side-dock-objects:not([hidden])'), total: matching.length, hasMore: end < matching.length, targets: matching.slice(parsed.data.offset, end).map(target => ({ ...target, label: target.label.slice(0, 300) })) });
    }
    const parsed = guidanceHighlightSchema.safeParse(input);
    if (name !== 'ui_highlight' || !parsed.success) return outcome({ status: 'invalid' }, true);
    const ids = [...new Set(parsed.data.targets)];
    if (ids.some(id => id.startsWith('object:'))) { openPanel('objects'); await settle(); }
    if (!valid() || signal?.aborted) return outcome({ status: 'cancelled', tabId: tab.id });
    for (const provider of activeProviders()) if (provider.targets.some(target => ids.includes(target.id))) provider.reveal(ids);
    await settle();
    if (!valid() || signal?.aborted) return outcome({ status: 'cancelled', tabId: tab.id });
    const targets = ids.map(id => elements().find(element => element.dataset['guidanceId'] === id));
    if (targets.some(element => !element)) return outcome({ status: 'unavailable', targets: ids.filter((_, index) => !targets[index]) }, true);
    const shown = targets as HTMLElement[];
    for (const element of shown) { element.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); element.classList.add('pf-ai-guidance'); }
    return new Promise(resolve => {
      const started = performance.now();
      let finished = false;
      const clearGlow = (): void => { for (const element of shown) element.classList.remove('pf-ai-guidance'); };
      const finish = (status: string, target?: string, interactionType?: string): void => {
        if (finished) return;
        finished = true;
        clearGlow(); clearTimeout(glow); clearTimeout(expiry); observer.disconnect(); unsubscribe();
        document.removeEventListener('click', clicked, true); document.removeEventListener('keydown', keyed, true);
        signal?.removeEventListener('abort', cancelled);
        resolve(outcome({ status, cueId: cueId ?? ids.join(','), tabId: tab.id, ...(target ? { target, interactionType } : {}) }));
      };
      const activate = (event: Event): void => {
        if (!event.isTrusted) return;
        if (!valid() || signal?.aborted) { finish('cancelled'); return; }
        if (performance.now() - started >= 30_000) { finish('expired'); return; }
        const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-guidance-id]') : null;
        if (!target || target.getAttribute('aria-disabled') === 'true' || target.matches(':disabled')) return;
        const index = shown.indexOf(target);
        if (index >= 0) finish('interacted', ids[index], event instanceof KeyboardEvent || (event as MouseEvent).detail === 0 ? 'keyboard' : 'click');
      };
      const clicked = (event: MouseEvent): void => activate(event);
      // Native buttons generate trusted clicks for Enter/Space. Treeitems activate on Enter in their own handler.
      const keyed = (event: KeyboardEvent): void => { if (event.key === 'Enter' && event.target instanceof Element && event.target.matches('[role="treeitem"]')) activate(event); };
      const cancelled = (): void => finish('cancelled');
      const unsubscribe = session.subscribe(() => { if (!valid()) cancelled(); });
      const observer = new MutationObserver(() => { if (shown.some(element => !available(element))) finish('unavailable'); });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'inert'] });
      const glow = setTimeout(clearGlow, 5000);
      const expiry = setTimeout(() => finish('expired'), 30_000);
      document.addEventListener('click', clicked, true); document.addEventListener('keydown', keyed, true);
      signal?.addEventListener('abort', cancelled, { once: true });
    });
  };
}
