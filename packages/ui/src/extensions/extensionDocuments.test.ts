// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { CommandRegistry, DocumentHost, SERVICE_DOCUMENT, modelInfoCommands } from '@pushform/commands';
import { Emitter } from '@pushform/core';
import type { DocumentSession } from '../session';
import { sessionExtensionDocuments } from './extensionDocuments';

function modelTab(id: string) {
  const host = new DocumentHost();
  const commands = new CommandRegistry({ tx: host, services: new Map<string, unknown>([[SERVICE_DOCUMENT, host]]) });
  commands.registerAll(modelInfoCommands);
  return { tab: { id, type: 'model', app: { commands, document: host } }, commands };
}

function layoutTab(id: string) {
  const doc = { state: { settings: { units: 'mm' as 'mm' | 'inch' | 'architectural' } }, events: new Emitter<{ change: unknown }>() };
  return { tab: { id, type: 'layout', doc }, doc };
}

describe('sessionExtensionDocuments', () => {
  it('finds open tabs by id, with the units extension panels show, and reports unit changes', () => {
    const model = modelTab('tab-1'), layout = layoutTab('tab-2');
    const tabs: unknown[] = [model.tab, layout.tab];
    const documents = sessionExtensionDocuments(() => ({ tabs } as unknown as DocumentSession));
    const modelDocument = documents.get('tab-1')!;
    expect(documents.get('tab-1')).toBe(modelDocument);
    expect(modelDocument.units()).toEqual({ system: 'imperial', lengthUnit: 'in', format: 'architectural', lengthPrecision: 4 });
    expect(modelDocument.model('Parts')).not.toBeNull();
    const heard: string[] = [];
    const stop = modelDocument.listen((change) => heard.push(change));
    model.commands.execute('model.setUnits', { patch: { format: 'decimal', lengthUnit: 'cm', lengthPrecision: 1 } });
    expect(heard).toEqual(['model', 'units']);
    expect(modelDocument.units()).toEqual({ system: 'metric', lengthUnit: 'cm', format: 'decimal', lengthPrecision: 1 });
    stop();

    const layoutDocument = documents.get('tab-2')!;
    expect(layoutDocument.model('Parts')).toBeNull();
    expect(layoutDocument.units()).toEqual({ system: 'metric', lengthUnit: 'mm', format: 'decimal', lengthPrecision: 1 });
    const layoutHeard: string[] = [];
    layoutDocument.listen((change) => layoutHeard.push(change));
    layout.doc.events.emit('change', {});
    layout.doc.state.settings.units = 'inch';
    layout.doc.events.emit('change', {});
    expect(layoutHeard).toEqual(['units']);
    expect(layoutDocument.units()).toMatchObject({ system: 'imperial', lengthUnit: 'in', format: 'decimal' });

    tabs.splice(0, 1);
    expect(documents.get('tab-1')).toBeNull();
  });
});
