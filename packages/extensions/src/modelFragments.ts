// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { capturePhysicalClipboard, copyModelSelection, pasteModelClipboard, physicalCopySize, DocumentHost, type ModelClipboard } from '@pushform/commands';
import { allocId, createEntityContainer, DEFAULT_AXES, DEFAULT_BEHAVIORS, Document, movePluginTargets, pluginTargetResolver, type ComponentDefinition, type ComponentInstance, type Draft, type EntityRef } from '@pushform/model';
import { m4identity, newGuid, type Box3, type DefId, type Id, type Mat4 } from '@pushform/core';
import { encodeModelSnapshot, openModelFile } from '@pushform/io/native-files';
import { ExtensionError } from '@pushform/extension-protocol';

export const NATIVE_FRAGMENT_LIMITS={bytes:64*1024*1024,decodedBytes:128*1024*1024}as const;
/** Trusted host data. Never serialize this state, clipboard or foreign metadata into a guest response. */
export interface NativeModelFragment { readonly host:DocumentHost;readonly root:EntityRef&{kind:'instance'};readonly bounds:Box3;readonly name:string }
const invalid=(message:string):never=>{throw new ExtensionError('validation.failed',message);};
function fragmentName(name:string):string{
 // eslint-disable-next-line no-control-regex
 if(!name.trim()||name.length>200||/[\u0000-\u001f\u007f]/.test(name))return invalid('Choose a module name of one to 200 characters.');return name.trim();
}
/** Reuse one existing root instance, otherwise wrap every root entity without moving or dropping any records. */
function normalizeRoot(host:DocumentHost,name:string):EntityRef&{kind:'instance'}{
 const state=host.doc.state,root=host.doc.rootDefinition.entities,only=[...root.instances.values()][0];
 const other=root.bodies.size+root.meshParts.size+root.guides.size+root.images.size+root.sectionPlanes.size+root.texts.size+root.dimensions.size+root.sketch.vertices.size+root.sketch.edges.size+root.sketch.faces.size;
 if(root.instances.size===1&&!other)return{kind:'instance',id:only!.id,path:[]};
 const exists=pluginTargetResolver(state);
 return host.edit('Prepare Native Module',draft=>{
  const definition=draft.definitions.get(draft.rootDefinitionId)!;definition.name=name;definition.isGroup=false;
  const id=allocId<DefId>(draft),next:ComponentDefinition={id,guid:newGuid(),name:'Model',description:'',isGroup:false,axes:DEFAULT_AXES,behaviors:DEFAULT_BEHAVIORS,entities:createEntityContainer(),bounds:null};
  draft.definitions.set(id,next as unknown as Draft<ComponentDefinition>);draft.rootDefinitionId=id;
  const instanceId=allocId<Id>(draft),instance:ComponentInstance={id:instanceId,definitionId:definition.id,transform:m4identity()as unknown as Mat4,name:'',materialId:null,tagId:draft.defaultTagId,hidden:false,locked:false,castShadows:true,receiveShadows:true,attributes:{}};
  next.entities.instances.set(instanceId,instance);next.entities.order.push(instanceId);
  movePluginTargets(draft,target=>target.kind==='bodyOccurrence'&&exists(target)?{...target,path:[instanceId,...target.path]}:undefined);
  return{kind:'instance',id:instanceId,path:[]};
 });
}
function completeFragment(host:DocumentHost,name:string):NativeModelFragment{
 const root=normalizeRoot(host,name);
 if(host.context.definitionId!==host.doc.state.rootDefinitionId){
  // Rebind the offline view to its new root; no live editor context is involved.
  const next=new DocumentHost(new Document(host.doc.state));for(const image of host.doc.state.images.values()){const blob=host.images.get(image.id);if(blob)next.images.register(image,blob.bytes,blob.mime);}host=next;
 }
 physicalCopySize(host,root);
 const clip=copyModelSelection(host.doc.state,[],[root],{images:host.images});if(!clip||clip.skipped)return invalid('The module has no complete measurable geometry.');
 for(const image of clip.state.images.values())if(!clip.images.has(image.id))return invalid('A module image is unavailable. Finish loading its images before saving.');
 return{host,root,bounds:clip.bounds,name};
}
/** Capture a revision into an independent model, so external IDs cannot bind to unrelated module entities. */
export function captureNativeModelFragment(source:DocumentHost,ref:EntityRef,expectedRevision:number,name:string):NativeModelFragment{
 name=fragmentName(name);
 if(source.doc.version!==expectedRevision)throw new ExtensionError('revision.stale','The model changed before the module could be captured.');
 if(source.undoStack.grouped||source.doc.inTransaction)throw new ExtensionError('unavailable','Finish the current model edit before capturing a module.');
 const clip=capturePhysicalClipboard(source,ref),host=new DocumentHost();
 for(const image of clip.state.images.values())if(!clip.images.has(image.id))return invalid('A captured image is unavailable. Finish loading its images before saving.');
 host.edit('Capture Native Module',draft=>{draft.meta.units={...clip.state.meta.units};pasteModelClipboard(draft,clip,[],m4identity(),host.images);});
 return completeFragment(host,name);
}
/** Native-only staged files are decoded with their own allocation budget before a host fragment is returned. */
export async function openNativeModelFragment(bytes:Uint8Array,name:string,signal?:AbortSignal):Promise<NativeModelFragment>{
 name=fragmentName(name);signal?.throwIfAborted();
 if(bytes.byteLength>NATIVE_FRAGMENT_LIMITS.bytes)throw new ExtensionError('limit.exceeded','The native module file exceeds 64 MiB.');
 const opened=await openModelFile(bytes,{nativeOnly:true,decodedBytes:NATIVE_FRAGMENT_LIMITS.decodedBytes,...(signal?{signal}:{})});signal?.throwIfAborted();
 const host=new DocumentHost(new Document(opened.state));
 // A file is a distinct import even when it was saved from the document currently open in the editor.
 host.edit('Stage Native Module',draft=>{draft.meta.guid=newGuid();});
 for(const [id,blob]of opened.images){const asset=host.doc.state.images.get(id);if(asset)host.images.register(asset,blob.bytes,blob.mime);}
 const fragment=completeFragment(host,name);signal?.throwIfAborted();return fragment;
}
/** Host-only bytes: exports/libraries must keep this behind granted file/asset services. */
export async function encodeNativeModelFragment(fragment:NativeModelFragment,signal?:AbortSignal):Promise<Uint8Array>{
 signal?.throwIfAborted();const images=[...fragment.host.doc.state.images.values()].map(image=>{const blob=fragment.host.images.get(image.id);if(!blob)return invalid('A module image is unavailable.');return{id:image.id,blob};});
 const bytes=await encodeModelSnapshot(fragment.host.doc.state,images,signal?{signal}:{});signal?.throwIfAborted();
 if(bytes.byteLength>NATIVE_FRAGMENT_LIMITS.bytes)throw new ExtensionError('limit.exceeded','The captured native module exceeds 64 MiB.');return bytes;
}
/** Recompute the canonical root/bounds after a trusted private native edit. */
export function refreshNativeModelFragment(fragment:NativeModelFragment):NativeModelFragment{return completeFragment(fragment.host,fragment.name);}
/** Prepare native import data without exposing opaque attachment bytes through the extension's geometry queries. */
export function nativeFragmentClipboard(fragment:NativeModelFragment):ModelClipboard{
 const clip=copyModelSelection(fragment.host.doc.state,[],[fragment.root],{images:fragment.host.images});if(!clip||clip.skipped)return invalid('The module snapshot is incomplete.');return clip;
}
