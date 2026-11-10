// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { ANGLE_TOL, COPLANAR_TOL, MERGE_TOL, basisToLocal, m4fromBasis, m4invert, m4mul, m4transformDir, m4transformPoint, v3cross, v3dot, v3len, v3scale, v3sub, type MMat4, type PlaneBasis, type Vec3 } from '@pushform/core';
import type { ModelApiErrorCode, ModelOperation } from '@pushform/extension-protocol';
import type { KernelClient } from '@pushform/kernel';
import type { ProfileSolidParams } from '@pushform/commands';
type Operation = Extract<ModelOperation,{op:'add_part'}>;
/** Prepare a normalized local solid while keeping all submitted sizes and frames physical. No document mutation. */
export async function physicalPartProfile(kernel:Pick<KernelClient,'extrudeSketch'>,op:Operation,world:MMat4,
  fail:(code:ModelApiErrorCode,message:string)=>never):Promise<ProfileSolidParams> {
  if(op.closedCurve&&op.points.length>512)fail('limit_exceeded','A closed profile curve supports up to 512 points.');
  if(Math.abs(op.distance)<=COPLANAR_TOL)fail('invalid_geometry','A physical part needs nonzero thickness.');
  const inverse=m4invert(world);if(!inverse)fail('invalid_geometry','The destination assembly has a singular transform.');
  const unit=(v:Vec3):Vec3=>{const n=v3len(v);if(!Number.isFinite(n)||!n)fail('invalid_geometry','Choose a finite nonzero profile direction.');return v3scale(v,1/n);};
  const normalWorld=unit(op.normal),firstWorld=op.points[0]!,edge=v3sub(op.points[1]!,firstWorld),inPlane=v3sub(edge,v3scale(normalWorld,v3dot(edge,normalWorld)));
  if(v3len(inPlane)<=MERGE_TOL)fail('invalid_geometry','The profile needs a nonzero first edge in its plane.');
  const uWorld=unit(inPlane),vWorld=v3cross(normalWorld,uWorld),directionWorld=unit(op.extrusionDirection??normalWorld);
  if(Math.abs(v3dot(normalWorld,directionWorld))<=ANGLE_TOL)fail('invalid_geometry','The extrusion direction must leave the profile plane.');
  for(const ring of [op.points,...op.holes??[]])for(const point of ring)if(Math.abs(v3dot(normalWorld,v3sub(point,firstWorld)))>COPLANAR_TOL)fail('invalid_geometry','The physical part profile must be planar.');
  const normal=unit([world[0]!*normalWorld[0]+world[1]!*normalWorld[1]+world[2]!*normalWorld[2],world[4]!*normalWorld[0]+world[5]!*normalWorld[1]+world[6]!*normalWorld[2],world[8]!*normalWorld[0]+world[9]!*normalWorld[1]+world[10]!*normalWorld[2]]);
  const points=op.points.map(point=>m4transformPoint(inverse!,point)),holes=(op.holes??[]).map(ring=>ring.map(point=>m4transformPoint(inverse!,point)));
  const first=points[0]!,localEdge=v3sub(points[1]!,first),u=unit(v3sub(localEdge,v3scale(normal,v3dot(localEdge,normal)))),basis:PlaneBasis={origin:first,u,v:v3cross(normal,u),n:normal};
  const localDirection=m4transformDir(inverse!,directionWorld),distance=op.distance*v3len(localDirection),sideDirection=unit(localDirection);
  const sourceFrame=op.referenceFrame??m4fromBasis(firstWorld,uWorld,vWorld,normalWorld);
  if(sourceFrame[3]!==0||sourceFrame[7]!==0||sourceFrame[11]!==0||sourceFrame[15]!==1||!m4invert(sourceFrame as MMat4))fail('invalid_geometry','The physical manufacturing frame must be invertible and affine.');
  const frame=m4mul(inverse!,sourceFrame as MMat4),polygon=[points,...holes].map(ring=>ring.map(point=>{const [x,y]=basisToLocal(basis,point);return[x,y];}));
  const result=await kernel.extrudeSketch({basis:{...basis,n:sideDirection},polygon,distance,nextFaceId:0,validateProfile:true});
  return{result,frame:[...frame],sideDirection:[...sideDirection],smoothSides:op.smoothSides??false,...(op.closedCurve?{curve:{points:points.map(p=>[...p]),normal:[...normal],offset:[...v3scale(sideDirection,distance)]}}:{})};
}
