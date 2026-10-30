// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useId, useMemo, useRef, useState, type JSX, type KeyboardEvent, type ReactNode } from 'react';
import { createLayoutTemplateState, DEFAULT_LAYOUT_TEMPLATE_ID, entitiesForLayer, LAYOUT_TEMPLATES, resolveLayoutText,
  type LayoutTemplate, type LayoutTemplateCategory } from '@pushform/layout';

type TemplateCategory = LayoutTemplateCategory | 'My Templates';
const CATEGORIES: readonly TemplateCategory[] = ['Paper', 'Storyboard', 'Titleblock', 'My Templates'];

/** Keep each section together so keyboard navigation follows the displayed order. */
function regionalTemplates(category: LayoutTemplateCategory): LayoutTemplate[] {
  const templates = LAYOUT_TEMPLATES.filter(template => template.category === category);
  let us = false;
  try { us = new Intl.Locale(navigator.language).region === 'US'; } catch { /* Keep international order for an unknown locale. */ }
  if (!us) return templates;
  const sections = [...new Set(templates.map(template => template.section))];
  return sections.flatMap(section => templates.filter(template => template.section === section)
    .sort((a, b) => Number(b.units === 'inch') - Number(a.units === 'inch')));
}

function TemplatePreview({ template }: { template: LayoutTemplate }): JSX.Element {
  const id = useId().replaceAll(':', ''), [width, height] = template.size;
  const state = useMemo(() => createLayoutTemplateState(template.id), [template.id]);
  const page = state.pages.get(state.pageOrder[0]!)!;
  return <svg className="pf-template-paper" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
    <rect width={width} height={height} fill="white" />
    {template.gridMm ? <>
      <defs><pattern id={id} width={template.gridMm} height={template.gridMm} patternUnits="userSpaceOnUse">
        <path d={`M ${template.gridMm} 0 H 0 V ${template.gridMm}`} fill="none" stroke="#9dc5d8" strokeWidth="0.7" />
      </pattern></defs>
      <rect x="10" y="10" width={width - 20} height={height - 20} fill={`url(#${id})`} />
    </> : null}
    {state.layerOrder.flatMap(layerId => entitiesForLayer(page, state, layerId)).map(entity => entity.kind === 'path'
      ? <polyline key={entity.id} points={[...entity.points, ...(entity.closed ? [entity.points[0]!] : [])].map(point => point.join(',')).join(' ')}
        fill="none" stroke="#64748b" strokeWidth="0.7" />
      : entity.text ? <text key={entity.id} x={entity.points[0]![0]} y={(entity.points[0]![1] + entity.points[1]![1]) / 2}
        fontFamily="Arial, sans-serif" fontSize={entity.text.fontSizePt * 25.4 / 72} fontWeight={entity.text.bold ? 'bold' : 'normal'}
        dominantBaseline="middle" fill="#64748b">{resolveLayoutText(entity.text.content, page, state)}</text> : null)}
  </svg>;
}

export function LayoutTemplateChooser({ onCreate, onCancel, savedTemplates, busy = false }: {
  onCreate: (templateId: string) => void; onCancel: () => void; savedTemplates?: ReactNode; busy?: boolean;
}): JSX.Element {
  const [category, setCategory] = useState<TemplateCategory>('Paper');
  const [selections, setSelections] = useState<Record<LayoutTemplateCategory, string>>({
    Paper: DEFAULT_LAYOUT_TEMPLATE_ID, Storyboard: 'storyboard-2x2', Titleblock: 'titleblock-a4',
  });
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId(), panelId = useId();
  const categories = savedTemplates ? CATEGORIES : CATEGORIES.slice(0, -1);
  const builtinCategory = category === 'My Templates' ? 'Paper' : category;
  const templates = useMemo(() => regionalTemplates(builtinCategory), [builtinCategory]);
  const selected = templates.find(template => template.id === selections[builtinCategory])!;
  const sections = [...new Set(templates.map(template => template.section))];
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  const choose = (template: LayoutTemplate) => setSelections(current => ({ ...current, [builtinCategory]: template.id }));
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); if (!busy) onCancel(); }
    if (event.key !== 'Tab') return;
    const controls = [...dialog.current!.querySelectorAll<HTMLElement>('button,input,[tabindex]')].filter(control => control.tabIndex >= 0 && !control.matches(':disabled'));
    const index = controls.indexOf(document.activeElement as HTMLElement);
    if (event.shiftKey && index <= 0) { event.preventDefault(); controls.at(-1)?.focus(); }
    else if (!event.shiftKey && (index < 0 || index === controls.length - 1)) { event.preventDefault(); controls[0]?.focus(); }
  };
  return <div className="pf-template-backdrop" onMouseDown={event => { if (!busy && event.target === event.currentTarget) onCancel(); }}>
    <div className="pf-template-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
      <div className="pf-template-heading">
        <div><h2 id={titleId}>Choose a Template</h2><p>Start your Layout document with the right paper and page setup.</p></div>
        <button type="button" className="pf-iconbtn" aria-label="Close template chooser" disabled={busy} onClick={onCancel}>×</button>
      </div>
      <div className="pf-template-tabs" role="tablist" aria-label="Template categories">
        {categories.map((item, index) => <button type="button" key={item} disabled={busy} data-guidance-id={`template-category:${item}`} role="tab" aria-selected={category === item}
          aria-controls={panelId} id={`${panelId}-${item.replaceAll(' ', '-')}`} tabIndex={category === item ? 0 : -1} onClick={() => setCategory(item)}
          onKeyDown={event => {
            if (busy || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
            event.preventDefault(); const next = (index + (event.key === 'ArrowRight' ? 1 : -1) + categories.length) % categories.length;
            setCategory(categories[next]!); dialog.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
          }}>{item}</button>)}
      </div>
      <div className={`pf-template-content${category === 'My Templates' ? ' pf-template-saved-content' : ''}`} role="tabpanel" id={panelId} aria-labelledby={`${panelId}-${category.replaceAll(' ', '-')}`}>
        {category === 'My Templates' ? savedTemplates : <div role="radiogroup" aria-label="Layout templates">
          {sections.map(section => <section className="pf-template-section" key={section}>
            <h3>{section}</h3>
            <div className="pf-template-grid">
              {templates.filter(template => template.section === section).map(template => <button type="button" key={template.id}
                role="radio" aria-checked={selected.id === template.id} aria-label={`${section}: ${template.name}`}
                tabIndex={selected.id === template.id ? 0 : -1} className={`pf-template-card${selected.id === template.id ? ' is-selected' : ''}`}
                onClick={() => choose(template)} onDoubleClick={() => onCreate(template.id)} onKeyDown={event => {
                  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
                  event.preventDefault(); const current = templates.indexOf(template);
                  const next = event.key === 'Home' ? 0 : event.key === 'End' ? templates.length - 1
                    : (current + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + templates.length) % templates.length;
                  choose(templates[next]!); dialog.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
                }}>
                <span className="pf-template-preview"><TemplatePreview template={template} /></span>
                <span className="pf-template-choice" aria-hidden="true">{selected.id === template.id ? '✓' : ''}</span>
                <span className="pf-template-name">{template.name}</span>
              </button>)}
            </div>
          </section>)}
        </div>}
      </div>
      {category !== 'My Templates' ? <div className="pf-template-footer">
        <div><strong>{selected.name}</strong><span>{selected.size[0]} × {selected.size[1]} mm{selected.gridMm ? ` · ${Number(selected.gridMm.toFixed(3))} mm grid` : ''}</span></div>
        <div className="pf-template-actions">
          <button type="button" className="pf-dialog-btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="pf-dialog-btn is-primary" onClick={() => onCreate(selected.id)}>Create Layout</button>
        </div>
      </div> : null}
    </div>
  </div>;
}
