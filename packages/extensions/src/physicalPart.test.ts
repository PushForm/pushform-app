// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import {afterEach,expect,it,vi} from 'vitest';
import {CommandRegistry,DocumentHost,SERVICE_DOCUMENT,SERVICE_KERNEL,editCommands,modelCommands,groupCommands,componentCommands,transformCommands,materialCommands,solidCommands,modelClipboard,copyModelSelection} from '@pushform/commands';
import {encodeModelSnapshot,openModelFile} from '@pushform/io/native-files';
import {InlineBackend,KernelClient} from '@pushform/kernel';
import {containerAt,contextMatrix,readPluginValue,type EntityRef} from '@pushform/model';
import {LENGTH_TOL,m4identity,m4mul,m4transformPoint,m4transformDir,m4translation,v3len,type Id,type Mat4,type MMat4} from '@pushform/core';
import {extensionManifestSchema,modelMetadataBatchSchema,type ModelRef,type ModelMetadataBatchInput} from '@pushform/extension-protocol';
import {ModelDocumentApi} from './modelApi';
import {ModelMetadataApi} from './metadataApi';
import {applyModelWithMetadata} from './modelMetadataBatch';
const kernels:KernelClient[]=[];afterEach(()=>{for(const kernel of kernels.splice(0))kernel.dispose();modelClipboard.set(null);});
async function setup(){
 const host=new DocumentHost(),kernel=new KernelClient(new InlineBackend());kernels.push(kernel);
 const commands=new CommandRegistry({tx:host,services:new Map<string,unknown>([[SERVICE_DOCUMENT,host],[SERVICE_KERNEL,kernel]])});
 for(const set of [editCommands,modelCommands,groupCommands,componentCommands,transformCommands,materialCommands,solidCommands])commands.registerAll(set);
 const body=commands.execute('model.addBox',{min:[0,0,0],max:[0.6,0.3,0.018]}) as number;
 const inner=(commands.execute('component.make',{refs:[{kind:'body',id:body,path:[]}],name:'Panel'})as{instanceId:number}).instanceId;
 const sibling=(await commands.execute('transform.apply',{refs:[{kind:'instance',id:inner,path:[]}],matrix:m4translation([1,0,0]),copy:true})as{refs:EntityRef[]}).refs[0]!.id;
 const outer=(commands.execute('component.make',{refs:[{kind:'instance',id:inner,path:[]},{kind:'instance',id:sibling,path:[]}],name:'Carcass'})as{instanceId:number}).instanceId;
 const other=(await commands.execute('transform.apply',{refs:[{kind:'instance',id:outer,path:[]}],matrix:m4translation([0,3,0]),copy:true})as{refs:EntityRef[]}).refs[0]!.id;
 const api=new ModelDocumentApi(commands,'Parts'),metadata=new ModelMetadataApi(commands),manifest=extensionManifestSchema.parse({id:'com.example.parts',name:'Parts',publisher:'Example',version:'1.0.0',apiVersion:'^0.1.0',editors:['modeling'],defaultLocale:'en',license:'MIT',permissions:['model.read','model.write'],files:{},contributions:[{target:'model.command',id:'com.example.parts.edit',name:'Edit'}],metadata:{dataVersion:1,schema:{type:'object',properties:{label:{type:'string'}},required:['label']}}});
 const run=(operations:{op:string;[key:string]:unknown}[],data?:ModelMetadataBatchInput)=>data?applyModelWithMetadata(api,metadata,manifest,{expectedRevision:host.doc.version,label:'Create physical parts',operations,metadata:modelMetadataBatchSchema.parse(data)}):api.apply({expectedRevision:host.doc.version,label:'Create physical parts',operations});
 const profile=(as='part',y=5)=>({op:'add_part',as,container:[outer,inner],points:[[4,y,6],[4.5,y,6],[4.5,y+0.3,6],[4,y+0.3,6]],normal:[0,0,1],distance:0.018});
 return{host,kernel,commands,api,metadata,manifest,body,inner,sibling,outer,other,run,profile};
}
function physicalBounds(host:DocumentHost,ref:ModelRef){
 const body=containerAt(host.doc.state,ref.path as Id[]).bodies.get(ref.id as Id)!,matrix=contextMatrix(host.doc.state,ref.path as Id[]),verts=body.mesh.verts,points=Array.from({length:verts.length/3},(_,i)=>m4transformPoint(matrix,[verts[i*3]!,verts[i*3+1]!,verts[i*3+2]!]));
 return{min:[0,1,2].map(a=>Math.min(...points.map(p=>p[a]!))),max:[0,1,2].map(a=>Math.max(...points.map(p=>p[a]!))),body,matrix};
}
it('creates linked one-body parts with actual nested aliases and independent placement labels in one Undo',async()=>{
 const s=await setup(),before=s.host.doc.state,undo=s.host.undoStack.length,selection=s.host.selection.snapshot(),context=[...s.host.context.path];
 const result=await s.run([{...s.profile('first'),componentName:'Shelf'},{op:'copy_part',as:'second',ref:'$first',container:[s.outer,s.inner],worldMatrix:m4translation([0,1,0])}],{expectedDataVersion:null,upserts:[{id:'first',target:{kind:'bodyOccurrence',created:'first'},value:{label:'Lower shelf'}},{id:'second',target:{kind:'bodyOccurrence',created:'second'},value:{label:'Upper shelf'}}]});
 const a=result.results![0]!.refs![0]!,b=result.results![1]!.refs![0]!;expect(a.kind).toBe('body');expect(b.kind).toBe('body');expect(a.path.length).toBe(3);expect(b.path.length).toBe(3);expect(a.path).not.toEqual(b.path);expect(a.id).toBe(b.id);
 const parentA=containerAt(s.host.doc.state,a.path.slice(0,-1)as Id[]).instances.get(a.path.at(-1)!as Id)!,parentB=containerAt(s.host.doc.state,b.path.slice(0,-1)as Id[]).instances.get(b.path.at(-1)!as Id)!;
 expect(parentA.definitionId).toBe(parentB.definitionId);const first=physicalBounds(s.host,a),second=physicalBounds(s.host,b);expect(first.min).toEqual([4,5,6]);expect(second.min).toEqual([4,6,6]);expect(first.body.valid&&second.body.valid).toBe(true);
 const own=s.host.doc.state.pluginData!.get(s.manifest.id)!;expect(own.entries.get('first')!.target).toEqual({kind:'bodyOccurrence',id:a.id,path:a.path});expect(own.entries.get('second')!.target).toEqual({kind:'bodyOccurrence',id:b.id,path:b.path});expect(readPluginValue(own,'first',1)).toEqual({label:'Lower shelf'});expect(readPluginValue(own,'second',1)).toEqual({label:'Upper shelf'});
 expect(s.host.undoStack.length).toBe(undo+1);expect(s.host.selection.snapshot()).toEqual(selection);expect(s.host.context.path).toEqual(context);s.host.undo();expect(s.host.doc.state.definitions).toEqual(before.definitions);expect(s.host.doc.state.pluginData).toEqual(before.pluginData);
});
it('refuses loose or multi-entity linked parts and rolls back earlier creation or invalid labels',async()=>{
 const s=await setup(),before=s.host.doc.state;
 await expect(s.run([s.profile('loose'),{op:'copy_part',ref:'$loose',container:[],worldMatrix:m4identity()}])).rejects.toThrow(/sole entity/);expect(s.host.doc.state.definitions).toEqual(before.definitions);
 await expect(s.run([{...s.profile('first'),componentName:'Shelf'},{op:'copy_part',as:'second',ref:'$first',container:[],worldMatrix:m4translation([0,1,0])}],{expectedDataVersion:null,upserts:[{id:'bad',target:{kind:'bodyOccurrence',created:'second'},value:{label:123}}]})).rejects.toThrow();expect(s.host.doc.state.definitions).toEqual(before.definitions);expect(s.host.doc.state.pluginData).toEqual(before.pluginData);
 const loose=s.commands.execute('model.addBox',{min:[5,0,0],max:[6,1,1]})as number;await expect(s.run([{op:'copy_part',ref:{kind:'body',id:loose,path:[]},container:[],worldMatrix:m4identity()}])).rejects.toThrow(/one-body component/);
});
it('creates two physical parts under nested shared ancestors with actual aliases, typed references and one Undo',async()=>{
 const s=await setup(),foreign=new Uint8Array([255,0,128]);
 s.host.doc.transact('Opaque fixture',draft=>{draft.pluginData=new Map([['org.example.foreign',{dataVersion:99,entries:new Map([['part',{target:{kind:'bodyOccurrence',id:s.body,path:[s.outer,s.inner]},references:[],payload:foreign}]])}]]);});
 s.host.selection.set([{kind:'instance',id:s.other,path:[]}]);const context=[...s.host.context.path],selection=s.host.selection.snapshot(),before=s.host.undoStack.length;
 const material=s.commands.execute('material.create',{name:'Maple',color:[0.8,0.7,0.4]})as number;
 const initial=s.host.undoStack.length,result=await s.run([s.profile('first'),{...s.profile('second',5.4),container:'$first'},{op:'paint_part',ref:'$first',materialId:material,scope:'shared'}],{expectedDataVersion:null,upserts:[
  {id:'first',target:{kind:'bodyOccurrence',created:'first'},value:{label:'Front 1'},references:[{target:{kind:'bodyOccurrence',id:s.body,path:[s.outer,s.inner]}},{target:{kind:'bodyOccurrence',id:s.body,path:[s.other,s.inner]}}]},
  {id:'second',target:{kind:'bodyOccurrence',created:'second'},value:{label:'Front 2'}}]});
 const refs=result.results!.slice(0,2).map(result=>result.refs![0]!),first=refs[0]!,second=refs[1]!;
 expect(first.path[0]).toBe(s.outer);expect(first.path[1]).not.toBe(s.inner);expect(second.path).toEqual(first.path);
 const record=s.host.doc.state.pluginData!.get(s.manifest.id)!;expect(record.entries.get('first')!.target).toEqual({kind:'bodyOccurrence',id:first.id,path:first.path});expect(record.entries.get('second')!.target).toEqual({kind:'bodyOccurrence',id:second.id,path:second.path});
 const source=[...containerAt(s.host.doc.state,first.path as Id[]).bodies.keys()].find(id=>id!==first.id&&id!==second.id)!;
 expect(record.entries.get('first')!.references[0]!.target).toEqual({kind:'bodyOccurrence',id:source,path:first.path});
 expect(record.entries.get('first')!.references[1]!.target).toEqual({kind:'bodyOccurrence',id:s.body,path:[s.other,s.inner]});
 expect(containerAt(s.host.doc.state,[s.other,s.inner]as Id[]).bodies.size).toBe(1);expect(containerAt(s.host.doc.state,[s.other,s.inner]as Id[]).bodies.has(s.body as Id)).toBe(true);
 const opaque=s.host.doc.state.pluginData!.get('org.example.foreign')!.entries.get('part')!;expect(opaque.payload).toEqual(foreign);expect(opaque.target).toEqual({kind:'bodyOccurrence',id:source,path:first.path});
 expect(s.host.context.path).toEqual(context);expect(s.host.selection.snapshot()).toEqual(selection);expect(s.host.undoStack.length).toBe(initial+1);expect(initial).toBe(before+1);
 s.host.undo();expect(s.host.doc.state.pluginData?.has(s.manifest.id)??false).toBe(false);expect(containerAt(s.host.doc.state,[s.outer,s.inner]as Id[]).bodies.size).toBe(1);s.host.redo();expect(readPluginValue(s.host.doc.state.pluginData!.get(s.manifest.id)!,'first',1)).toEqual({label:'Front 1'});
});
for(const world of [m4identity(),[0,-2,0,0,-3,0,0,0,0.5,0,0.5,0,4,5,6,1]as MMat4])it('preserves physical world dimensions and manufacturing frame through affine containers',async()=>{
 const s=await setup();await s.commands.execute('transform.apply',{refs:[{kind:'instance',id:s.outer,path:[]}],matrix:world});const result=await s.run([s.profile()]),ref=result.results![0]!.refs![0]!,bounds=physicalBounds(s.host,ref);
 bounds.min.forEach((value,i)=>expect(Math.abs(value-[4,5,6][i]!)).toBeLessThan(LENGTH_TOL));bounds.max.forEach((value,i)=>expect(Math.abs(value-[4.5,5.3,6.018][i]!)).toBeLessThan(LENGTH_TOL));expect(bounds.body.valid).toBe(true);
 const frame=m4mul(bounds.matrix,bounds.body.referenceFrame!);frame.slice(12,15).forEach((value,i)=>expect(Math.abs(value-[4,5,6][i]!)).toBeLessThan(LENGTH_TOL));frame.slice(0,12).forEach((value,i)=>expect(value).toBeCloseTo(m4identity()[i]!,8));
});
it('refuses invalid destinations and rolls back isolated ancestors and parts on a later operation or metadata failure',async()=>{
 const s=await setup();const original=s.host.doc.state,undo=s.host.undoStack.length;
 const same=()=>{expect({...s.host.doc.state,meta:{...s.host.doc.state.meta,nextId:original.meta.nextId}}).toEqual(original);expect(s.host.undoStack.length).toBe(undo);};
 await expect(s.run([s.profile(),{op:'paint_part',ref:{kind:'body',id:99999,path:[]},materialId:null,scope:'shared'}])).rejects.toThrow();same();
 await expect(s.run([s.profile()],{expectedDataVersion:null,upserts:[{id:'invalid',target:{kind:'bodyOccurrence',created:'part'},value:{label:4}}]})).rejects.toThrow();same();
 s.commands.execute('instance.setLocked',{refs:[{kind:'instance',id:s.outer,path:[]}],locked:true});const locked=s.host.doc.state;await expect(s.run([s.profile()])).rejects.toThrow(/Unlock/);expect(s.host.doc.state).toBe(locked);
});
it('a failed isolation cannot corrupt an earlier alias used by a following batch',async()=>{
 const s=await setup(),first=await s.run([{...s.profile('prior'),scope:'shared'}]);const prior=first.results![0]!.refs![0]!,before=s.host.doc.state;
 await expect(s.run([{...s.profile('failed'),container:'$prior'}],{expectedDataVersion:null,upserts:[{id:'invalid',target:{kind:'bodyOccurrence',created:'failed'},value:{label:4}}]})).rejects.toThrow();
 expect(containerAt(s.host.doc.state,prior.path as Id[]).bodies.has(prior.id as Id)).toBe(true);
 const next=await s.run([{...s.profile('next'),container:'$prior',scope:'shared'}]);expect(next.results![0]!.refs![0]!.path).toEqual(prior.path);expect(s.host.doc.state.definitions.size).toBe(before.definitions.size);
});
it('keeps explicit shared scope and refuses outside or context-remapping placement destinations',async()=>{
 const s=await setup();s.host.setContext([s.outer as Id]);const before=s.host.doc.state;
 await expect(s.run([s.profile()])).rejects.toThrow(/Leave this shared assembly/);expect(s.host.doc.state).toBe(before);
 await expect(s.run([{...s.profile(),container:[s.other]}])).rejects.toThrow(/inside/);expect(s.host.doc.state).toBe(before);
 const result=await s.run([{...s.profile(),container:[s.outer],scope:'shared'}]),ref=result.results![0]!.refs![0]!;
 expect(ref.path).toEqual([s.outer]);expect(containerAt(s.host.doc.state,[s.other as Id]).bodies.has(ref.id as Id)).toBe(true);expect(s.host.context.path).toEqual([s.outer]);
});
it('cancelling after kernel work rolls back parts, identity separation and metadata together',async()=>{
 const s=await setup(),controller=new AbortController(),original=s.host.doc.state,undo=s.host.undoStack.length,extrude=s.kernel.extrudeSketch.bind(s.kernel);
 vi.spyOn(s.kernel,'extrudeSketch').mockImplementation(async input=>{const result=await extrude(input);controller.abort();return result;});
 await expect(applyModelWithMetadata(s.api,s.metadata,s.manifest,{expectedRevision:s.host.doc.version,label:'Cancelled part',operations:[s.profile()],metadata:modelMetadataBatchSchema.parse({expectedDataVersion:null,upserts:[{id:'part',target:{kind:'bodyOccurrence',created:'part'},value:{label:'Cancelled'}}]})},controller.signal)).rejects.toThrow(/stopped/);
 expect({...s.host.doc.state,meta:{...s.host.doc.state.meta,nextId:original.meta.nextId}}).toEqual(original);expect(s.host.undoStack.length).toBe(undo);expect(s.host.context.path).toEqual([]);
});
it('invalid physical profiles and manufacturing frames fail without isolating the destination',async()=>{
 const s=await setup(),before=s.host.doc.state;
 for(const patch of [{distance:0},{normal:[0,0,0]},{referenceFrame:Array(16).fill(0)},{extrusionDirection:[1,0,0]},{points:[[4,5,6],[4.5,5,6],[4.5,5.3,6.1],[4,5.3,6]]}]){await expect(s.run([{...s.profile(),...patch}])).rejects.toThrow();expect(s.host.doc.state).toBe(before);}
});
it('later physical operations and metadata follow captured references through earlier isolation',async()=>{
 const s=await setup(),result=await s.run([s.profile('part'),{op:'transform_part',ref:{kind:'body',id:s.body,path:[s.outer,s.inner]},worldMatrix:m4translation([0,0,0.1])}],{expectedDataVersion:null,upserts:[{id:'link',target:{kind:'bodyOccurrence',created:'part'},value:{label:'Linked'},references:[{target:{kind:'bodyOccurrence',id:s.body,path:[s.outer,s.inner]}}]}]});
 const moved=result.results![1]!.refs![0]!,bounds=physicalBounds(s.host,moved);expect(Math.abs(bounds.min[2]!-0.1)).toBeLessThan(LENGTH_TOL);
 expect(s.host.doc.state.pluginData!.get(s.manifest.id)!.entries.get('link')!.references[0]!.target).toEqual({kind:'bodyOccurrence',id:moved.id,path:moved.path});
 expect(physicalBounds(s.host,{kind:'body',id:s.body,path:[s.other,s.inner]}).min[2]).toBe(0);
});
it('a subsequent placement paint continues shared creations, result references and further aliases',async()=>{
 const s=await setup(),result=await s.run([{...s.profile('shared'),scope:'shared'},{op:'paint_part',ref:'$shared',scope:'placement',materialId:null},{...s.profile('next',5.4),container:'$shared'}],{expectedDataVersion:null,upserts:[{id:'shared',target:{kind:'bodyOccurrence',created:'shared'},value:{label:'Selected creation'}},{id:'next',target:{kind:'bodyOccurrence',created:'next'},value:{label:'Next'}}]});
 const first=result.results![0]!.refs![0]!,painted=result.results![1]!.refs![0]!,next=result.results![2]!.refs![0]!;
 expect(first).toEqual(painted);expect(first.path).toEqual(next.path);expect(first.path[1]).not.toBe(s.inner);expect(result.created.shared).toBe(first.id);
 expect(s.host.doc.state.pluginData!.get(s.manifest.id)!.entries.get('shared')!.target).toEqual({kind:'bodyOccurrence',id:first.id,path:first.path});
 expect(containerAt(s.host.doc.state,[s.other,s.inner]as Id[]).bodies.size).toBe(2);
});
const AFFINE:MMat4=[0,-2,0,0,-3,0,0,0,0,0.5,0.5,0,4,5,6,1];
function grooveTool(matrix:MMat4=m4identity()){
 const direction=m4transformDir(matrix,[0,0,1]);
 return{op:'add_part',as:'cutter',container:[],points:[[0.1,-0.01,0.009],[0.2,-0.01,0.009],[0.2,0.31,0.009],[0.1,0.31,0.009]].map(p=>m4transformPoint(matrix,p as [number,number,number])),normal:[0,0,1],extrusionDirection:direction,distance:0.021*v3len(direction)};
}
for(const matrix of [m4identity(),AFFINE])it(`cuts physical parts in different containers and preserves a retained tool (${matrix===AFFINE?'affine':'identity'})`,async()=>{
 const s=await setup();await s.commands.execute('transform.apply',{refs:[{kind:'instance',id:s.outer,path:[]}],matrix});
 const opaque=new Uint8Array([255,0,128]);s.host.doc.transact('Opaque source',draft=>{draft.pluginData=new Map([['org.example.foreign',{dataVersion:99,entries:new Map([['source',{target:{kind:'bodyOccurrence',id:s.body,path:[s.outer,s.inner]},references:[],payload:opaque}]])}]]);});
 const initial=s.host.undoStack.length,context=[...s.host.context.path],before=s.host.doc.state;
 const result=await s.run([grooveTool(matrix),{op:'boolean_part',as:'grooved',mode:'subtract',target:{kind:'body',id:s.body,path:[s.outer,s.inner]},tool:'$cutter'}],{expectedDataVersion:null,upserts:[{id:'grooved',target:{kind:'bodyOccurrence',created:'grooved'},value:{label:'Grooved panel'},references:[{target:{kind:'bodyOccurrence',created:'cutter'}},{target:{kind:'bodyOccurrence',id:s.body,path:[s.outer,s.inner]}}]}]});
 const part=result.results![1]!.refs![0]!,cutter=result.results![0]!.refs![0]!,actual=physicalBounds(s.host,part).body;
 expect(actual.props.volume).toBeCloseTo(0.6*0.3*0.018-0.1*0.3*0.009,8);expect(actual.valid).toBe(true);expect(part.path[1]).not.toBe(s.inner);
 expect(containerAt(s.host.doc.state,[s.other,s.inner]as Id[]).bodies.get(s.body as Id)!.props.volume).toBeCloseTo(0.6*0.3*0.018,9);
 const sibling=containerAt(s.host.doc.state,[s.outer]as Id[]).instances;const siblingId=[...sibling.keys()].find(id=>id!==part.path[1])!;
 expect(containerAt(s.host.doc.state,[s.outer,siblingId]as Id[]).bodies.size).toBe(1);
 expect(physicalBounds(s.host,cutter).body.props.volume).toBeCloseTo(0.1*0.32*0.021*(matrix===AFFINE?3:1),8);
 const entry=s.host.doc.state.pluginData!.get(s.manifest.id)!.entries.get('grooved')!;expect(entry.references[1]!.target).toEqual({kind:'bodyOccurrence',id:part.id,path:part.path});
 expect([...s.host.doc.state.pluginData!.get('org.example.foreign')!.entries.values()].some(entry=>entry.target.kind==='bodyOccurrence'&&entry.target.id===part.id&&String(entry.payload)===String(opaque))).toBe(true);
 expect(s.host.context.path).toEqual(context);expect(s.host.undoStack.length).toBe(initial+1);s.host.undoStack.undo();expect(s.host.doc.state.definitions).toEqual(before.definitions);s.host.undoStack.redo();expect(physicalBounds(s.host,part).body.valid).toBe(true);
});
it('consumes only the selected physical cutter and continues subsequent target aliases',async()=>{
 const s=await setup(),result=await s.run([grooveTool(),{op:'boolean_part',as:'grooved',mode:'subtract',target:{kind:'body',id:s.body,path:[s.outer,s.inner]},tool:'$cutter',keepTool:false},{op:'paint_part',ref:'$grooved',scope:'shared',materialId:null}]);
 expect(s.host.doc.state.definitions.get(s.host.doc.state.rootDefinitionId)!.entities.bodies.size).toBe(0);expect(result.results![1]!.deleted).toHaveLength(1);expect(result.results![2]!.refs).toEqual(result.results![1]!.refs);
});
it('rolls physical isolation and cuts back after metadata failure, cancellation or a later operation',async()=>{
 const s=await setup(),operations=[grooveTool(),{op:'boolean_part',as:'cut',mode:'subtract',target:{kind:'body',id:s.body,path:[s.outer,s.inner]},tool:'$cutter'}],before=s.host.doc.state,depth=s.host.undoStack.length;
 await expect(s.run([...operations,{op:'paint',refs:[{kind:'body',id:999999}],material:null}])).rejects.toThrow();expect(s.host.doc.state.definitions).toEqual(before.definitions);expect(s.host.undoStack.length).toBe(depth);
 await expect(s.run(operations,{expectedDataVersion:null,upserts:[{id:'bad',target:{kind:'bodyOccurrence',created:'cut'},value:{label:123}}]})).rejects.toThrow();expect(s.host.doc.state.definitions).toEqual(before.definitions);
 const abort=new AbortController(),boolean=s.kernel.boolean.bind(s.kernel);vi.spyOn(s.kernel,'boolean').mockImplementation(async input=>{const result=await boolean(input);abort.abort();return result;});
 await expect(s.api.apply({expectedRevision:s.host.doc.version,label:'Cancelled cut',operations},abort.signal)).rejects.toThrow();expect(s.host.doc.state.definitions).toEqual(before.definitions);expect(s.host.undoStack.length).toBe(depth);
});
it('refuses empty, nonoverlapping, locked and self cuts without retaining isolation',async()=>{
 const s=await setup(),target={kind:'body',id:s.body,path:[s.outer,s.inner]},before=s.host.doc.state;
 for(const points of [[[2,2,0],[3,2,0],[3,3,0],[2,3,0]],[[-1,-1,-1],[2,-1,-1],[2,2,-1],[-1,2,-1]]]){
  await expect(s.run([{op:'add_part',as:'tool',points,normal:[0,0,1],distance:3},{op:'boolean_part',mode:'subtract',target,tool:'$tool'}])).rejects.toThrow();expect(s.host.doc.state.definitions).toEqual(before.definitions);
 }
 await expect(s.run([{op:'boolean_part',mode:'subtract',target,tool:target}])).rejects.toThrow(/own tool/);expect(s.host.doc.state.definitions).toEqual(before.definitions);
 s.host.doc.transact('Lock target',draft=>{draft.definitions.forEach(def=>{const body=def.entities.bodies.get(s.body as Id);if(body)body.locked=true;});});const locked=s.host.doc.state;
 await expect(s.run([grooveTool(),{op:'boolean_part',mode:'subtract',target,tool:'$cutter'}])).rejects.toThrow(/Unlock/);expect(s.host.doc.state.definitions).toEqual(locked.definitions);
});
for(const mode of ['union','intersect']as const)it(`retains the tool and native face materials for a physical ${mode}`,async()=>{
 const s=await setup(),material=s.commands.execute('material.create',{name:'Tool face',color:[0.5,0.2,0.1]})as number;
 const result=await s.run([{op:'add_part',as:'tool',points:[[0.5,0,0],[0.7,0,0],[0.7,0.3,0],[0.5,0.3,0]],normal:[0,0,1],distance:0.018},{op:'paint_part',ref:'$tool',scope:'shared',materialId:material},{op:'boolean_part',mode,target:{kind:'body',id:s.body,path:[s.outer,s.inner]},tool:'$tool'}]);
 const target=physicalBounds(s.host,result.results![2]!.refs![0]!).body;
 expect(target.props.volume).toBeCloseTo((mode==='union'?0.7:0.1)*0.3*0.018,8);expect([...target.faces.values()].some(face=>face.frontMaterialId===material)).toBe(true);
 expect(physicalBounds(s.host,result.results![0]!.refs![0]!).body.props.volume).toBeCloseTo(0.2*0.3*0.018,9);
});
it('isolates both shared operands when consuming a cutter in another descendant container',async()=>{
 const s=await setup();s.host.doc.transact('Overlapping shared placement',draft=>{for(const def of draft.definitions.values()){const sibling=def.entities.instances.get(s.sibling);if(sibling)sibling.transform=m4translation([0.1,0,0]) as unknown as Mat4;}});
 const before=s.host.doc.state,result=await s.run([{op:'boolean_part',mode:'subtract',target:{kind:'body',id:s.body,path:[s.outer,s.inner]},tool:{kind:'body',id:s.body,path:[s.outer,s.sibling]},keepTool:false}]);
 const part=result.results![0]!.refs![0]!,deleted=result.results![0]!.deleted![0]!;
 expect(physicalBounds(s.host,part).body.props.volume).toBeCloseTo(0.1*0.3*0.018,8);expect(containerAt(s.host.doc.state,deleted.path as Id[]).bodies.size).toBe(0);
 expect(containerAt(s.host.doc.state,[s.other,s.inner]as Id[]).bodies.size).toBe(1);expect(containerAt(s.host.doc.state,[s.other,s.sibling]as Id[]).bodies.size).toBe(1);
 s.host.undoStack.undo();expect(s.host.doc.state.definitions).toEqual(before.definitions);
});
it('returns every disconnected component with the source manufacturing frame',async()=>{
 const s=await setup();s.host.doc.transact('Source frame',draft=>{for(const def of draft.definitions.values()){const body=def.entities.bodies.get(s.body as Id);if(body)body.referenceFrame=m4translation([0.2,0.1,0]) as unknown as Mat4;}});
 const result=await s.run([{...grooveTool(),points:[[2,0,0],[2.1,0,0],[2.1,0.3,0],[2,0.3,0]],distance:0.018},{op:'boolean_part',mode:'union',target:{kind:'body',id:s.body,path:[s.outer,s.inner]},tool:'$cutter'}]);
 const refs=result.results![1]!.refs!;expect(refs).toHaveLength(2);for(const ref of refs){const body=physicalBounds(s.host,ref).body;expect(body.valid).toBe(true);expect(body.referenceFrame).toEqual(m4translation([0.2,0.1,0]));}
});
it('copies physical geometry and inherited material into an isolated destination while continuing external references',async()=>{
 const s=await setup(),material=s.commands.execute('material.create',{name:'Inherited maple',color:[0.8,0.7,0.4]})as number;
 await s.commands.execute('transform.apply',{refs:[{kind:'instance',id:s.outer,path:[]}],matrix:AFFINE});
 s.host.doc.transact('Copy metadata fixture',draft=>{
  draft.definitions.get(draft.rootDefinitionId)!.entities.instances.get(s.outer as Id)!.materialId=material as never;
  draft.pluginData=new Map([['org.example.foreign',{dataVersion:99,entries:new Map([['source',{target:{kind:'bodyOccurrence',id:s.body,path:[s.outer,s.inner]},payload:new Uint8Array([255,0,128]),references:[{target:{kind:'bodyOccurrence',id:s.body,path:[s.outer,s.inner]}},{target:{kind:'bodyOccurrence',id:s.body,path:[s.other,s.inner]}}]}]])}]]);
 });
 const source={kind:'body' as const,id:s.body,path:[s.outer,s.inner]},bounds=physicalBounds(s.host,source),clipboard=copyModelSelection(s.host.doc.state,[],[{kind:'instance',id:s.outer as Id,path:[]}])!;modelClipboard.set(clipboard);
 s.host.selection.set([{kind:'instance',id:s.outer as Id,path:[]}]);const before=s.host.doc.state,depth=s.host.undoStack.length;
 const result=await s.run([{op:'copy_physical',as:'copy',ref:source,container:[s.other,s.inner],worldMatrix:m4translation([0,0,1])}],{expectedDataVersion:null,upserts:[{id:'copied',target:{kind:'bodyOccurrence',created:'copy'},value:{label:'Copied panel'}}]});
 const made=result.results![0]!.refs![0]!,actual=physicalBounds(s.host,made);expect(made.path[1]).not.toBe(s.inner);expect(made.path[0]).toBe(s.other);expect(actual.body.materialId).toBe(material);
 for(const a of [0,1,2]){expect(Math.abs(actual.min[a]!-bounds.min[a]!-(a===2?1:0))).toBeLessThan(LENGTH_TOL);expect(Math.abs(actual.max[a]!-bounds.max[a]!-(a===2?1:0))).toBeLessThan(LENGTH_TOL);}
 expect(modelClipboard.current).toBe(clipboard);expect(s.host.context.path).toEqual([]);expect(s.host.selection.refs).toEqual([{kind:'instance',id:s.outer,path:[]}]);
 const entries=[...s.host.doc.state.pluginData!.get('org.example.foreign')!.entries.values()],copied=entries.find(e=>e.target.kind==='bodyOccurrence'&&e.target.id===made.id)!;
 expect(Array.from(copied.payload)).toEqual([255,0,128]);expect(copied.references[0]!.target).toEqual({kind:'bodyOccurrence',id:made.id,path:made.path});
 const external=copied.references[1]!.target;expect(external.kind).toBe('bodyOccurrence');if(external.kind!=='bodyOccurrence')throw Error('Expected occurrence');expect(external.path).toEqual(made.path);expect(external.id).not.toBe(made.id);expect(containerAt(s.host.doc.state,external.path as Id[]).bodies.has(external.id as Id)).toBe(true);expect(copied.references.some(r=>r.unresolved)).toBe(false);
 expect(s.host.undoStack.length).toBe(depth+1);s.host.undoStack.undo();expect(s.host.doc.state.definitions).toEqual(before.definitions);expect(s.host.doc.state.pluginData).toEqual(before.pluginData);s.host.undoStack.redo();expect(physicalBounds(s.host,made).body.valid).toBe(true);
});
it('links component copies by default and copies their complete definitions when independent',async()=>{
 const s=await setup(),source={kind:'instance',id:s.inner,path:[s.outer]},definition=containerAt(s.host.doc.state,[s.outer]as Id[]).instances.get(s.inner as Id)!.definitionId;
 const linked=await s.run([{op:'copy_physical',as:'linked',ref:source,container:[],worldMatrix:m4translation([0,0,1])}]),first=linked.results![0]!.refs![0]!;
 expect(containerAt(s.host.doc.state,[]).instances.get(first.id as Id)!.definitionId).toBe(definition);
 const independent=await s.run([{op:'copy_physical',as:'independent',ref:source,container:[],worldMatrix:m4translation([0,0,2]),independent:true}]),second=independent.results![0]!.refs![0]!,made=containerAt(s.host.doc.state,[]).instances.get(second.id as Id)!;
 expect(made.definitionId).not.toBe(definition);expect([...s.host.doc.state.definitions.get(made.definitionId)!.entities.bodies.keys()]).not.toContain(s.body);
});
it('keeps groups independent while retaining linked child components',async()=>{
 const s=await setup(),group=s.commands.execute('group.make',{refs:[{kind:'instance',id:s.outer,path:[]}]})as{instanceId:number},original=containerAt(s.host.doc.state,[]).instances.get(group.instanceId as Id)!.definitionId;
 const result=await s.run([{op:'copy_physical',ref:{kind:'instance',id:group.instanceId,path:[]},worldMatrix:m4translation([0,0,1])}]),ref=result.results![0]!.refs![0]!,copy=containerAt(s.host.doc.state,[]).instances.get(ref.id as Id)!;
 expect(copy.definitionId).not.toBe(original);expect(s.host.doc.state.definitions.get(copy.definitionId)!.isGroup).toBe(true);
 const sourceChild=[...s.host.doc.state.definitions.get(original)!.entities.instances.values()][0]!,copiedChild=[...s.host.doc.state.definitions.get(copy.definitionId)!.entities.instances.values()][0]!;expect(copiedChild.definitionId).toBe(sourceChild.definitionId);
});
it('rolls copy isolation and metadata back after later failure and post-copy cancellation',async()=>{
 const s=await setup(),copy={op:'copy_physical',as:'copied',ref:{kind:'body',id:s.body,path:[s.outer,s.inner]},container:[s.other,s.inner],worldMatrix:m4translation([0,0,1])},before=s.host.doc.state;
 await expect(s.run([copy,{op:'paint_part',ref:{kind:'body',id:999999,path:[]},scope:'shared',materialId:null}])).rejects.toThrow();expect(s.host.doc.state.definitions).toEqual(before.definitions);
 await expect(s.run([copy],{expectedDataVersion:null,upserts:[{id:'bad',target:{kind:'bodyOccurrence',created:'copied'},value:{label:123}}]})).rejects.toThrow();expect(s.host.doc.state.definitions).toEqual(before.definitions);
 const abort=new AbortController(),pending=s.api.apply({expectedRevision:s.host.doc.version,label:'Cancelled copy',operations:[copy]},abort.signal);abort.abort();await expect(pending).rejects.toThrow();expect(s.host.doc.state.definitions).toEqual(before.definitions);
});
it('refuses singular, outside-context, locked and recursive copies before retaining any destination change',async()=>{
 const s=await setup(),before=s.host.doc.state,base={op:'copy_physical',ref:{kind:'instance',id:s.outer,path:[]},container:[s.outer,s.inner],worldMatrix:m4identity()};
 await expect(s.run([base])).rejects.toThrow(/inside itself/);expect(s.host.doc.state.definitions).toEqual(before.definitions);
 await expect(s.run([{...base,container:[],worldMatrix:Array(16).fill(0)}])).rejects.toThrow(/affine/);expect(s.host.doc.state.definitions).toEqual(before.definitions);
 s.host.context.path=[s.outer as Id];await expect(s.run([{...base,ref:{kind:'body',id:s.body,path:[s.outer,s.inner]},container:[s.other,s.inner]}])).rejects.toThrow();s.host.context.path=[];
 s.host.doc.transact('Lock copy destination',draft=>{draft.definitions.get(draft.rootDefinitionId)!.entities.instances.get(s.other)!.locked=true;});const locked=s.host.doc.state;
 await expect(s.run([{...base,container:[s.other,s.inner]}])).rejects.toThrow(/Unlock/);expect(s.host.doc.state.definitions).toEqual(locked.definitions);
});
it('allocates unique copied curve and surface IDs that survive native file reopening',async()=>{
 const s=await setup(),points=Array.from({length:16},(_,i)=>[Math.cos(i*Math.PI/8),Math.sin(i*Math.PI/8),0]);
 const created=await s.run([{op:'add_part',as:'round',container:[],points,normal:[0,0,1],distance:0.018,closedCurve:true}]),source=created.results![0]!.refs![0]!;
 const result=await s.run([{op:'copy_physical',as:'roundCopy',ref:source,worldMatrix:m4translation([3,0,0])}]),copy=result.results![0]!.refs![0]!,a=physicalBounds(s.host,source).body,b=physicalBounds(s.host,copy).body;
 expect(b.curves.size).toBe(2);expect(b.surfaces.size).toBe(1);expect([...b.curves.keys()].some(id=>a.curves.has(id))).toBe(false);expect([...b.surfaces.keys()].some(id=>a.surfaces.has(id))).toBe(false);
 const assembly=s.commands.execute('component.make',{refs:[source],name:'Curved module'})as{instanceId:number};
 await s.run([{op:'copy_physical',ref:{kind:'instance',id:assembly.instanceId,path:[]},worldMatrix:m4translation([0,3,0]),independent:true}]);
 const reopened=await openModelFile(await encodeModelSnapshot(s.host.doc.state,[]));expect(reopened.state.definitions.get(reopened.state.rootDefinitionId)!.entities.bodies.get(copy.id as Id)!.curves.size).toBe(2);
});
it('bounds repeated physical occurrences across the whole batch without partially retaining a copy',async()=>{
 const s=await setup();let instance=s.outer;
 for(let depth=0;depth<11;depth++){
  const copy=await s.commands.execute('transform.apply',{refs:[{kind:'instance',id:instance,path:[]}],matrix:m4translation([1,0,0]),copy:true})as{refs:EntityRef[]};
  instance=(s.commands.execute('component.make',{refs:[{kind:'instance',id:instance,path:[]},copy.refs[0]!],name:'Repeated assembly'})as{instanceId:number}).instanceId;
 }
 const before=s.host.doc.state,copy={op:'copy_physical',ref:{kind:'instance',id:instance,path:[]},worldMatrix:m4translation([0,0,2])};
 await expect(s.run([copy,copy])).rejects.toThrow(/copied geometry budget/);expect(s.host.doc.state.definitions).toEqual(before.definitions);
});
