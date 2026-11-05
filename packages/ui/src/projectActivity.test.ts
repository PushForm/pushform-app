// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import type { CloudFilesApi, CloudSavedFile, ProjectActivityEvent } from '@pushform/cloud';
import { bodyFromMesh, type Draft } from '@pushform/model';
import { meshBox } from '@pushform/core';
import type { LayoutDocumentState } from '@pushform/layout';
import { IDBFactory } from 'fake-indexeddb';
import { loadNativeRefresh } from './nativeRefresh';
import { createLayoutDocument } from '@pushform/layout';
import { createApp } from './bootstrap';
import { DocumentSession } from './session';
import { encodeLayoutSnapshot, openLayoutFile } from '@pushform/io';
import { fingerprint } from './projectActivity';
import { saveCloudDocument } from './cloudDocuments';
function addShape(d: Draft<LayoutDocumentState>): void {
 const id=d.meta.nextId++, page=d.pages.get(d.pageOrder[0]!)!;
 page.entities.set(id,{id,kind:'path',layerId:d.activeLayerId,points:[[0,0],[10,10]],closed:false});page.entityOrder.push(id);
}
const sessions: DocumentSession[]=[];
afterEach(()=>{for(const s of sessions)s.dispose();sessions.length=0;});
function setup(enabled=true){const events: ProjectActivityEvent[]=[];const s=new DocumentSession(createApp({demo:false,expose:false}),()=>createApp({demo:false,expose:false}),true,null,null,null,undefined,{enabled:()=>enabled,record:e=>events.push(e)});sessions.push(s);return {s,events};}
function draw(s:DocumentSession){const tab=s.newLayout();tab.doc.transact('draw',addShape);return tab;}
it('ignores blank documents, selection, tab changes, camera movement, empty transactions and metadata names',()=>{
 const {s,events}=setup();s.newLayout();s.activate(s.tabs[0]!.id);
 if(s.active.type==='model'){s.active.app.document.doc.transact('empty',()=>{});s.active.app.document.doc.transact('name',d=>{d.definitions.get(d.rootDefinitionId)!.name='renamed';});}
 expect(events).toEqual([]);
});
it('records real committed layout edits and actual closure, but not a refused close',()=>{
 const {s,events}=setup(),tab=draw(s);
 expect(events.map(e=>e.kind)).toEqual(['project_started','meaningful_edit']);
 expect(events[1]!.fingerprint).toBe(fingerprint(tab.doc.state,'layout'));
 expect(s.close(tab.id)).toBe(false);expect(events).toHaveLength(2);
 expect(s.close(tab.id,true)).toBe(true);expect(events.at(-1)!.kind).toBe('document_closed');
 expect(JSON.stringify(events)).not.toMatch(/Untitled|renamed|points|entities/);
});
it('records nonempty decoded opens but does not treat activating an existing cloud tab as reopening',async()=>{
 const doc=createLayoutDocument();doc.transact('draw',addShape);
 const opened=await openLayoutFile(await encodeLayoutSnapshot(doc.state));const {s,events}=setup();
 const identity='cloud:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:33333333-3333-4333-8333-333333333333:44444444-4444-4444-8444-444444444444';
 s.openLayoutFile(opened,'private-name.pfl',identity);s.openLayoutFile(opened,'private-name.pfl',identity);
 expect(events.map(e=>e.kind)).toEqual(['reopen_succeeded']);expect(events[0]!.storage).toBe('cloud');
 const n=events.length;await expect(s.openLayoutBytes(new Uint8Array([0,1]),'bad.pfl')).rejects.toThrow();expect(events).toHaveLength(n);
});
it('records nothing when measurement is disabled',()=>{const {s,events}=setup(false);const tab=draw(s);s.close(tab.id,true);expect(events).toEqual([]);});

it('records a local save only after the native checkpoint is published; quota failures do not count',async()=>{
 const values=new Map<string,string>();const storage={getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);},removeItem:(k:string)=>{values.delete(k);}};
 const native=await loadNativeRefresh(storage,new IDBFactory());expect(native).toBeTruthy();
 const events:ProjectActivityEvent[]=[];const s=new DocumentSession(createApp({demo:false,expose:false}),()=>createApp({demo:false,expose:false}),true,null,storage,null,native,{enabled:()=>true,record:e=>events.push(e)});sessions.push(s);
 const tab=draw(s);s.flushRefreshPersistence();await s.settledNativeRecovery();
 expect(events.some(e=>e.kind==='save_succeeded'&&e.fingerprint===fingerprint(tab.doc.state,'layout'))).toBe(true);
 const count=events.filter(e=>e.kind==='save_succeeded').length;
 vi.spyOn(native!.store,'publish').mockRejectedValueOnce(new Error('quota'));
 tab.doc.transact('another shape',addShape);s.flushRefreshPersistence();await s.settledNativeRecovery();
 expect(events.filter(e=>e.kind==='save_succeeded')).toHaveLength(count);
});

it('records modeling geometry but not camera navigation or undo back to the opened baseline',()=>{
 const {s,events}=setup();const tab=s.active;if(tab.type!=='model')throw Error('model expected');
 tab.app.viewport.camera.zoomExtents();expect(events).toEqual([]);
 tab.app.document.edit('box',d=>{bodyFromMesh(d,meshBox([0,0,0],[1,1,1]),{container:d.definitions.get(d.rootDefinitionId)!.entities});});
 expect(events.map(e=>e.kind)).toEqual(['project_started','meaningful_edit']);
 tab.app.document.undo();
 expect(events.filter(e=>e.kind==='meaningful_edit')).toHaveLength(1);
});

it('reopens the same saved local checkpoint after a real session closes',async()=>{
 const values=new Map<string,string>(),db=new IDBFactory();
 const storage={getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);},removeItem:(k:string)=>{values.delete(k);}};
 const events:ProjectActivityEvent[]=[],sink={enabled:()=>true,record:(e:ProjectActivityEvent)=>events.push(e)};
 const create=async()=>{const native=await loadNativeRefresh(storage,db);const session=new DocumentSession(createApp({demo:false,expose:false}),()=>createApp({demo:false,expose:false}),true,null,storage,null,native,sink);sessions.push(session);return session;};
 const first=await create(),tab=draw(first),hash=fingerprint(tab.doc.state,'layout');
 first.flushRefreshPersistence();await first.settledNativeRecovery();first.dispose();sessions.splice(sessions.indexOf(first),1);
 const second=await create();expect(second.tabs.some(t=>t.type==='layout'&&fingerprint(t.doc.state,'layout')===hash)).toBe(true);
 const kinds=events.filter(e=>e.fingerprint===hash).map(e=>e.kind);
 expect(kinds).toEqual(['project_started','meaningful_edit','save_succeeded','document_closed','reopen_succeeded']);
});

it('records only a successful cloud commit and the captured snapshot when more edits happen during upload',async()=>{
 const {s,events}=setup(),tab=draw(s),hash=fingerprint(tab.doc.state,'layout');
 const saved={file:{id:'11111111-1111-4111-8111-111111111111',project_id:'22222222-2222-4222-8222-222222222222',name:'Plan.pfl'},revision:{id:'33333333-3333-4333-8333-333333333333'}} as CloudSavedFile;
 const api={save:vi.fn<CloudFilesApi['save']>().mockRejectedValueOnce(Error('offline'))} as unknown as CloudFilesApi;
 await expect(saveCloudDocument(api,s,tab,()=> 'owner',saved.file.project_id,'Plan')).rejects.toThrow('offline');
 expect(events.filter(e=>e.kind==='save_succeeded')).toEqual([]);
 let finish!:(value:CloudSavedFile)=>void;vi.mocked(api.save).mockImplementationOnce(()=>new Promise(r=>{finish=r;}));
 const saving=saveCloudDocument(api,s,tab,()=> 'owner',saved.file.project_id,'Plan');
 await vi.waitFor(()=>expect(api.save).toHaveBeenCalledTimes(2));tab.doc.transact('later shape',addShape);finish(saved);await saving;
 const evidence=events.filter(e=>e.kind==='save_succeeded');expect(evidence).toHaveLength(1);
 expect(evidence[0]).toMatchObject({fingerprint:hash,storage:'cloud',fileId:saved.file.id,revisionId:saved.revision.id});
 expect(evidence[0]!.fingerprint).not.toBe(fingerprint(tab.doc.state,'layout'));
});
