// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import{afterEach,expect,it}from'vitest';
import{CommandRegistry,DocumentHost,SERVICE_DOCUMENT,SERVICE_KERNEL,modelCommands,groupCommands,componentCommands,transformCommands,materialCommands,copyModelSelection,modelClipboard,pasteModelClipboard}from'@pushform/commands';
import{InlineBackend,KernelClient}from'@pushform/kernel';
import{allocId,containerAt,Document,type EntityRef,type ImageAsset}from'@pushform/model';
import{m4translation,type Id,type ImageId,type MaterialId}from'@pushform/core';
import{encodeModelSnapshot}from'@pushform/io/native-files';
import{captureNativeModelFragment,encodeNativeModelFragment,nativeFragmentClipboard,openNativeModelFragment}from'./modelFragments';
import{NativeFragmentLibrary}from'./nativeFragmentLibrary';import{memoryAssetStore}from'./assetStore';
import{NATIVE_FRAGMENT_MIME}from'@pushform/extension-protocol';import{ModelDocumentApi}from'./modelApi';
const kernels:KernelClient[]=[];afterEach(()=>{for(const k of kernels.splice(0))k.dispose();modelClipboard.set(null);});
async function fixture(){
 const host=new DocumentHost(),kernel=new KernelClient(new InlineBackend());kernels.push(kernel);
 const commands=new CommandRegistry({tx:host,services:new Map<string,unknown>([[SERVICE_DOCUMENT,host],[SERVICE_KERNEL,kernel]])});for(const set of[modelCommands,groupCommands,componentCommands,transformCommands,materialCommands])commands.registerAll(set);
 const body=commands.execute('model.addBox',{min:[0,0,0],max:[0.6,0.3,0.018]})as Id,inner=(commands.execute('component.make',{refs:[{kind:'body',id:body,path:[]}],name:'Module part'})as{instanceId:Id}).instanceId,outer=(commands.execute('component.make',{refs:[{kind:'instance',id:inner,path:[]}],name:'Module source'})as{instanceId:Id}).instanceId;
 const other=(await commands.execute('transform.apply',{refs:[{kind:'instance',id:outer,path:[]}],matrix:m4translation([0,2,0]),copy:true})as{refs:EntityRef[]}).refs[0]!.id;
 const material=commands.execute('material.create',{name:'Inherited module material',color:[0.7,0.5,0.3]})as MaterialId;let image:ImageId|undefined;
 const png=new Uint8Array([0x89,80,78,71,1,2,3]);
 host.doc.transact('Module attachments',draft=>{
  image=allocId<ImageId>(draft);const asset:ImageAsset={id:image,name:'module.png',mime:'image/png',width:1,height:1,sha256:'fixture'};draft.images.set(image,asset);host.images.register(asset,png);
  draft.materials.get(material)!.texture={imageId:image,widthM:0.1,heightM:0.1,colorize:false};draft.definitions.get(draft.rootDefinitionId)!.entities.instances.get(outer)!.materialId=material;
  draft.pluginData=new Map([['org.example.foreign',{dataVersion:99,entries:new Map([['part',{target:{kind:'bodyOccurrence',id:body,path:[outer,inner]},payload:new Uint8Array([255,0,128]),references:[{target:{kind:'bodyOccurrence',id:body,path:[outer,inner]}},{target:{kind:'bodyOccurrence',id:body,path:[other,inner]}}]}]])}]]);
 });
 const ref:EntityRef={kind:'instance',id:outer,path:[]};return{host,commands,body,inner,outer,other,material,image:image!,png,ref};
}
it('captures nested geometry, effective textures and opaque records without changing the editor or clipboard',async()=>{
 const s=await fixture(),clipboard=copyModelSelection(s.host.doc.state,[],[s.ref])!;modelClipboard.set(clipboard);s.host.selection.set([{kind:'instance',id:s.other,path:[]}]);
 const before=s.host.doc.state,undo=s.host.undoStack.length,fragment=captureNativeModelFragment(s.host,s.ref,s.host.doc.version,'Personal cabinet');
 expect(s.host.doc.state).toBe(before);expect(s.host.undoStack.length).toBe(undo);expect(modelClipboard.current).toBe(clipboard);expect(s.host.selection.refs).toEqual([{kind:'instance',id:s.other,path:[]}]);expect(s.host.context.path).toEqual([]);
 expect(fragment.host.doc.state.meta.guid).not.toBe(before.meta.guid);expect(fragment.bounds).toEqual(clipboard.bounds);
 const entry=[...fragment.host.doc.state.pluginData!.get('org.example.foreign')!.entries.values()][0]!;expect(Array.from(entry.payload)).toEqual([255,0,128]);expect(entry.references[0]!.unresolved).not.toBe(true);expect(entry.references[1]!.unresolved).toBe(true);
 const images=[...fragment.host.doc.state.images.values()];expect(images).toHaveLength(1);expect(fragment.host.images.get(images[0]!.id)!.bytes).toEqual(s.png);
 const root=containerAt(fragment.host.doc.state,[]).instances.get(fragment.root.id)!;expect(root.materialId).not.toBeNull();expect(fragment.host.doc.state.materials.get(root.materialId!)!.texture).not.toBeNull();
});
it('native round trips preserve opaque bytes without adding repeated wrapper definitions',async()=>{
 const s=await fixture(),fragment=captureNativeModelFragment(s.host,s.ref,s.host.doc.version,'Shared module'),bytes=await encodeNativeModelFragment(fragment),first=await openNativeModelFragment(bytes,'Imported module'),second=await openNativeModelFragment(await encodeNativeModelFragment(first),'Reopened module');
 expect(new TextDecoder().decode(bytes.subarray(0,8))).toBe('PUSHFRM2');expect(first.host.doc.state.meta.guid).not.toBe(fragment.host.doc.state.meta.guid);expect(second.host.doc.state.definitions.size).toBe(first.host.doc.state.definitions.size);expect(second.root).toEqual(first.root);
 for(const staged of[first,second]){const record=staged.host.doc.state.pluginData!.get('org.example.foreign')!;expect(record.dataVersion).toBe(99);const entry=[...record.entries.values()][0]!;expect(Array.from(entry.payload)).toEqual([255,0,128]);expect(entry.references[1]!.unresolved).toBe(true);}
 // A file opened from the same original GUID is still an independent import.
 const target=new DocumentHost(new Document(fragment.host.doc.state)),sourceDefinition=containerAt(target.doc.state,[]).instances.get(fragment.root.id)!.definitionId;
 const copied=target.edit('Import native module',draft=>pasteModelClipboard(draft,nativeFragmentClipboard(first),[],m4translation([0,0,1]),target.images));
 expect(containerAt(target.doc.state,[]).instances.get(copied[0]!.id)!.definitionId).not.toBe(sourceDefinition);
});
it('wraps all roots once and rebases their occurrence attachments while preserving native entities',async()=>{
 const s=await fixture();s.commands.execute('model.addBox',{min:[2,0,0],max:[3,1,1]});
 const bytes=await encodeModelSnapshot(s.host.doc.state,[{id:s.image,blob:{bytes:s.png,mime:'image/png'}}]),fragment=await openNativeModelFragment(bytes,'Whole model module'),state=fragment.host.doc.state,root=containerAt(state,[]),wrapped=state.definitions.get(root.instances.get(fragment.root.id)!.definitionId)!;
 expect(root.instances.size).toBe(1);expect(root.bodies.size).toBe(0);expect(wrapped.entities.instances.size).toBe(2);expect(wrapped.entities.bodies.size).toBe(1);expect(fragment.host.context.definitionId).toBe(state.rootDefinitionId);
 const entry=[...state.pluginData!.get('org.example.foreign')!.entries.values()][0]!;expect(entry.target.kind).toBe('bodyOccurrence');if(entry.target.kind!=='bodyOccurrence')throw Error('Expected occurrence');expect(entry.target.path[0]).toBe(fragment.root.id);expect(entry.references.every(ref=>!ref.unresolved)).toBe(true);
 const again=await openNativeModelFragment(await encodeNativeModelFragment(fragment),'Whole model module');expect(again.host.doc.state.definitions.size).toBe(state.definitions.size);
});
it('rejects stale, busy, missing-image and cancelled module requests without changing the source',async()=>{
 const s=await fixture(),before=s.host.doc.state;expect(()=>captureNativeModelFragment(s.host,s.ref,s.host.doc.version-1,'Stale')).toThrow(/changed/);
 s.host.undoStack.beginGroup('Pending edit');expect(()=>captureNativeModelFragment(s.host,s.ref,s.host.doc.version,'Busy')).toThrow(/Finish/);s.host.undoStack.endGroup(false);
 const fragment=captureNativeModelFragment(s.host,s.ref,s.host.doc.version,'Cancel'),abort=new AbortController();abort.abort(new Error('Module cancelled'));await expect(encodeNativeModelFragment(fragment,abort.signal)).rejects.toThrow('Module cancelled');await expect(openNativeModelFragment(new Uint8Array(),'Cancel',abort.signal)).rejects.toThrow('Module cancelled');
 s.host.images.remove(s.image);expect(()=>captureNativeModelFragment(s.host,s.ref,s.host.doc.version,'Incomplete')).toThrow(/image.*unavailable/);expect(s.host.doc.state).toBe(before);
});
it('stores native modules under one extension namespace with checksums and revision conflicts',async()=>{
 const s=await fixture(),fragment=captureNativeModelFragment(s.host,s.ref,s.host.doc.version,'Personal module'),store=memoryAssetStore(),library=new NativeFragmentLibrary('com.example.owner',store),signal=new AbortController().signal;
 const saved=await library.save(fragment,'modules/Maple & birch.pf',null,signal);expect(saved.contentType).toBe(NATIVE_FRAGMENT_MIME);expect(saved.byteLength).toBeGreaterThan(0);
 const loaded=await library.open(saved.key,saved.revision,signal);expect([...loaded.host.doc.state.pluginData!.get('org.example.foreign')!.entries.values()][0]!.payload).toEqual(new Uint8Array([255,0,128]));
 await expect(library.save(fragment,saved.key,null,signal)).rejects.toMatchObject({code:'revision.stale'});
 await expect(new NativeFragmentLibrary('com.example.other',store).open(saved.key,saved.revision,signal)).rejects.toMatchObject({code:'unavailable'});
 const updated=await library.save(fragment,saved.key,saved.revision,signal);await expect(library.open(saved.key,saved.revision,signal)).rejects.toMatchObject({code:'revision.stale'});
 const corrupt=new NativeFragmentLibrary('com.example.owner',{...store,read:async(...args)=>{const row=await store.read(...args);if(row)row.bytes[0]=(row.bytes[0]??0)^1;return row;}});await expect(corrupt.open(saved.key,updated.revision,signal)).rejects.toMatchObject({code:'validation.failed'});
});
it('captures curved bodies into valid independent native module files',async()=>{
 const s=await fixture(),api=new ModelDocumentApi(s.commands,'Module fixture'),made=await api.apply({expectedRevision:s.host.doc.version,label:'Curved module',operations:[{op:'add_part',points:Array.from({length:16},(_,i)=>[Math.cos(i*Math.PI/8),Math.sin(i*Math.PI/8),0]),normal:[0,0,1],distance:0.018,closedCurve:true}]});
 const source=made.results[0]!.refs![0]!,fragment=captureNativeModelFragment(s.host,{...source,id:source.id as Id,path:source.path as Id[]}as EntityRef,s.host.doc.version,'Round module');
 const reopened=await openNativeModelFragment(await encodeNativeModelFragment(fragment),'Round module'),parts=[...reopened.host.doc.state.definitions.values()].flatMap(d=>[...d.entities.bodies.values()]);expect(parts).toHaveLength(1);expect(parts[0]!.curves.size).toBe(2);expect(parts[0]!.surfaces.size).toBe(1);
});
