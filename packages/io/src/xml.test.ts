// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { parseXml } from './xml';

it('captures only requested subtrees with their inherited namespaces and exact source', () => {
  const source = `<page xmlns="urn:page" xmlns:e="urn:entities" xmlns:x="urn:outer">
    <e:group><e:skpModelRef id="id1" xmlns:x="urn:inner" setting="a &gt; b"><!--retain--><x:unknown value='42'/><![CDATA[<literal>]]></e:skpModelRef></e:group>
  </page>`;
  const root = parseXml(source, {}, name => name === 'skpModelRef');
  expect(root.source).toBeUndefined();
  const viewport = root.children[0]!.children[0]!;
  expect(viewport.source?.namespaces).toEqual({ '': 'urn:page', e: 'urn:entities', x: 'urn:inner' });
  expect(viewport.source?.ancestors).toEqual(['page', 'group']);
  expect(viewport.source?.xml).toBe(`<e:skpModelRef id="id1" xmlns:x="urn:inner" setting="a &gt; b"><!--retain--><x:unknown value='42'/><![CDATA[<literal>]]></e:skpModelRef>`);
});

it('keeps extension ids from overwriting an unqualified entity id', () => {
  expect(parseXml('<entity xmlns:custom="urn:custom" id="id1" custom:id="foreign"/>').attrs)
    .toMatchObject({ id: 'id1', 'custom:id': 'foreign' });
  expect(parseXml('<entity xmlns:custom="urn:custom" custom:id="foreign" id="id1"/>').attrs.id).toBe('id1');
});

it('scopes a namespace declaration to its element and descendants', () => {
  const root = parseXml(`<doc xmlns:p="urn:a"><one xmlns:p="urn:b"><inner p:v="1"/></one><two p:v="2"/></doc>`, { 'urn:a': 'a', 'urn:b': 'b' });
  expect(root.children[0]!.children[0]!.attrs).toEqual({ 'b:v': '1' });
  expect(root.children[1]!.attrs).toEqual({ 'a:v': '2' });
});
