// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { ContainerIdentityChange } from '@pushform/commands';
import type { MetadataTarget } from '@pushform/extension-protocol';
/** Ordered physical occurrence continuation inside one atomic batch. Shared targets remain explicit. */
export class ModelBatchIdentity {
  private readonly changes:ContainerIdentityChange[]=[];
  get version():number{return this.changes.length;}
  append(changes:readonly ContainerIdentityChange[]):void{this.changes.push(...changes);}
  occurrence(id:number,path:readonly number[]):{id:number;path:number[]}{
    let next=id,at=[...path];
    for(const change of this.changes)if(change.prefix.every((id,i)=>at[i]===id)){next=change.ids.get(next)??next;at=at.map(id=>change.ids.get(id)??id);}
    return{id:next,path:at};
  }
  path(path:readonly number[]):number[]{
    let next=[...path];for(const change of this.changes)if(change.prefix.every((id,i)=>next[i]===id))next=next.map(id=>change.ids.get(id)??id);return next;
  }
  target=(target:MetadataTarget):MetadataTarget=>target.kind==='bodyOccurrence'?{kind:'bodyOccurrence',...this.occurrence(target.id,target.path)}:target;
}
