// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { m4invert, newGuid, PushFormError, type DefId, type Id, type MMat4 } from '@pushform/core';
import { containerAt, pluginTargetResolver, type EntityRef } from '@pushform/model';
import { defineCommand } from '../registry/Command';
import { hostOf } from '../host/services';
import type { DocumentHost } from '../host/DocumentHost';
import { captureContainerOccurrence, isolateContainerOccurrence, type ContainerIdentityChange } from './groups';
import { copyModelSelection, pasteModelClipboard, type ModelClipboard } from './clipboard';
import { EntityRefSchema } from './sketch';
import { toEntityRefs } from './transform';
import { draftContainerAt } from './context';

export const PHYSICAL_COPY_LIMITS={definitions:2000,entities:20000,vertices:1000000}as const;
export interface PhysicalCopySize { entities:number;vertices:number }
/** Count complete nested geometry before allocating a snapshot; no partial assembly may be copied. */
export function physicalCopySize(host:DocumentHost,ref:EntityRef):PhysicalCopySize {
 captureContainerOccurrence(host,ref.path,false);
 if(ref.kind!=='body'&&ref.kind!=='instance')throw new PushFormError('part.target','Choose one body or assembly placement to copy.');
 const state=host.doc.state,root=containerAt(state,ref.path),size:PhysicalCopySize={entities:1,vertices:0},seen=new Set<DefId>(),counts=new Map<DefId,number>();
 const body=(id:Id,at:ReturnType<typeof containerAt>)=>{
  const part=at.bodies.get(id);if(!part||!part.valid)throw new PushFormError('part.target','The captured solid is missing or invalid.');size.vertices+=part.mesh.verts.length/3;
 };
 const check=()=>{if(size.entities>PHYSICAL_COPY_LIMITS.entities||size.vertices>PHYSICAL_COPY_LIMITS.vertices||seen.size>PHYSICAL_COPY_LIMITS.definitions)throw new PushFormError('part.limit','The complete copy exceeds its geometry budget. Choose a smaller assembly.');};
 const definition=(id:DefId,stack:Set<DefId>):number=>{
  if(stack.has(id))throw new PushFormError('part.recursive','The captured assembly contains a recursive definition.');
  const counted=counts.get(id);if(counted!==undefined)return counted;seen.add(id);check();
  const def=state.definitions.get(id);if(!def)throw new PushFormError('part.target','A captured assembly definition is missing.');
  const at=def.entities;let entities=at.order.length;for(const part of at.bodies.values()){body(part.id,at);check();}
  for(const part of at.meshParts.values()){size.vertices+=part.geometry.positions.length/3;check();}
  size.vertices+=at.sketch.vertices.size;check();
  const next=new Set(stack);next.add(id);for(const child of at.instances.values()){entities+=definition(child.definitionId,next);if(entities>PHYSICAL_COPY_LIMITS.entities)throw new PushFormError('part.limit','The complete physical assembly exceeds its occurrence budget.');}
  counts.set(id,entities);return entities;
 };
 if(ref.kind==='body')body(ref.id,root);else{const instance=root.instances.get(ref.id);if(!instance)throw new PushFormError('part.target','The captured assembly is missing.');size.entities+=definition(instance.definitionId,new Set());}
 check();return size;
}
export interface PhysicalCopyResult { ref:Extract<EntityRef,{kind:'body'|'instance'}>;changes:ContainerIdentityChange[];size:PhysicalCopySize }
/** Owned read-only snapshot with the captured root's effective appearance. Never changes the live clipboard. */
export function capturePhysicalClipboard(host:DocumentHost,ref:EntityRef):ModelClipboard{
 physicalCopySize(host,ref);const state=host.doc.state;let into=containerAt(state,[]),rootMaterial=state.defaultMaterialId;
 for(const id of ref.path){const instance=into.instances.get(id)!;rootMaterial=instance.materialId??rootMaterial;into=state.definitions.get(instance.definitionId)!.entities;}
 const clip=copyModelSelection(state,ref.path,[ref],{images:host.images,rootMaterial});
 if(!clip||clip.skipped)throw new PushFormError('part.target','The complete captured entity could not be copied.');return clip;
}
/** One native clipboard snapshot, never installed in the live clipboard or selected by the command. */
export const copyPhysical=defineCommand({
 id:'part.copy',title:'Copy Physical Entity',category:'internal',undoable:true,
 params:z.object({ref:EntityRefSchema,container:z.array(z.number().int().nonnegative()).max(64),worldMatrix:z.array(z.number().finite()).length(16),independent:z.boolean().default(false)}),
 run(ctx,p):PhysicalCopyResult {
  const host=hostOf(ctx),ref=toEntityRefs([p.ref])[0]!,size=physicalCopySize(host,ref),matrix=p.worldMatrix as MMat4;
  if(matrix[3]!==0||matrix[7]!==0||matrix[11]!==0||matrix[15]!==1||!m4invert(matrix)?.every(Number.isFinite))throw new PushFormError('part.matrix','Choose an invertible affine world transform.');
  captureContainerOccurrence(host,p.container,true);
  if(!p.independent&&ref.kind==='instance'&&[...ref.path,ref.id].every((id,i)=>p.container[i]===id))throw new PushFormError('paste.recursive','A linked assembly cannot be copied inside itself. Choose an independent copy or another destination.');
  const clip=capturePhysicalClipboard(host,ref);
  // Only the owned snapshot changes here; ordinary linked components retain their native identity.
  for(const def of clip.state.definitions.values())if(def.id!==clip.state.rootDefinitionId&&(p.independent||def.isGroup))def.guid=newGuid();
  return host.edit('Copy Physical Entity',draft=>{
   const isolated=isolateContainerOccurrence(draft,p.container),exists=pluginTargetResolver(clip.state),origin=clip.metadataOrigin!.path;
   for(const record of clip.state.pluginData?.values()??[])for(const entry of record.entries.values())for(const reference of entry.references){
    const target=reference.target;if(target.kind!=='bodyOccurrence')continue;
    const copied=origin.every((id,i)=>target.path[i]===id)&&exists({...target,path:target.path.slice(origin.length)});if(copied)continue;
    let id=target.id,path=[...target.path];for(const change of isolated.changes)if(change.prefix.every((id,i)=>path[i]===id)){id=change.ids.get(id)??id;path=path.map(id=>change.ids.get(id)??id);}reference.target={kind:'bodyOccurrence',id,path};
   }
   const refs=pasteModelClipboard(draft,clip,isolated.path,matrix,host.images);
   const root=refs[0];if(refs.length!==1||!root||(root.kind!=='body'&&root.kind!=='instance')||root.kind!==ref.kind)throw new PushFormError('part.target','The captured copy did not produce one complete root.');
   if(root.kind==='body')draftContainerAt(draft,root.path).bodies.get(root.id)!.locked=false;
   return{ref:root,changes:isolated.changes,size};
  });
 },
});
