// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Vec3 } from '@pushform/core';
import type { CutBox, PanelRing } from './mesh';
import * as D from './dimensions';

export type CabinetType = 'base' | 'wall' | 'tall';
export type CabinetFrame = 'frameless' | 'face_frame';
export type CabinetOverlay = 'full' | 'partial' | 'inset';
export type CabinetDoorStyle = 'slab' | 'shaker' | 'raised' | 'glass' | 'none';
export type CabinetCornerStyle = 'blind' | 'diagonal' | 'l_shaped';
export type CabinetSide = 'left' | 'right';
export type CabinetFinishedEnds = 'none' | 'left' | 'right' | 'both';
export type CabinetFinish = { readonly paint: string } | { readonly stain: string };

export interface CabinetParams {
  readonly type: CabinetType;
  readonly width: number;
  readonly height?: number | undefined;
  readonly depth?: number | undefined;
  readonly at?: Vec3 | undefined;
  readonly frame?: CabinetFrame | undefined;
  readonly overlay?: CabinetOverlay | undefined;
  readonly doorStyle?: CabinetDoorStyle | undefined;
  readonly doors?: number | undefined;
  readonly drawers?: number | undefined;
  readonly drawerBoxes?: boolean | undefined;
  readonly sinkFront?: boolean | undefined;
  readonly shelves?: number | undefined;
  readonly toeKick?: boolean | undefined;
  readonly back?: boolean | undefined;
  readonly finish?: { readonly paint?: string | undefined; readonly stain?: string | undefined } | undefined;
  readonly finishedEnds?: CabinetFinishedEnds | undefined;
  readonly name?: string | undefined;
  readonly stackedDoors?: boolean | undefined;
  readonly upperDoorHeight?: number | undefined;
  readonly upperDoorStyle?: CabinetDoorStyle | undefined;
  readonly corner?: {
    readonly style: CabinetCornerStyle;
    readonly side?: CabinetSide | undefined;
    readonly returnWidth?: number | undefined;
    readonly blindWidth?: number | undefined;
    readonly lazySusan?: boolean | undefined;
  } | undefined;
}

/** Every parameter as resolved. */
export interface CabinetUsed {
  readonly type: CabinetType;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly at: Vec3;
  readonly frame: CabinetFrame;
  readonly overlay: CabinetOverlay;
  readonly doorStyle: CabinetDoorStyle;
  readonly doors: number;
  readonly drawers: number;
  readonly drawerBoxes: boolean;
  readonly sinkFront: boolean;
  readonly shelves: number;
  readonly toeKick: boolean;
  readonly back: boolean;
  readonly finish: CabinetFinish;
  readonly finishedEnds: CabinetFinishedEnds;
  readonly stackedDoors: boolean;
  readonly upperDoorHeight?: number;
  readonly upperDoorStyle?: CabinetDoorStyle;
  readonly corner?: { readonly style: CabinetCornerStyle; readonly side: CabinetSide; readonly returnWidth?: number; readonly blindWidth?: number; readonly lazySusan: boolean };
}

export type CabinetShape = { readonly kind: 'stock'; readonly cuts: readonly CutBox[] } | { readonly kind: 'lofted'; readonly rings: readonly PanelRing[] }
  | { readonly kind: 'prism'; readonly outline: readonly (readonly [number, number])[]; readonly round: boolean };

/** One solid. Its local axes are x along its length and grain, y across its width and z through its thickness. */
export type CabinetRole = 'box' | 'show' | 'glass';

export interface CabinetPart {
  readonly name: string;
  /** The door, drawer or frame holding the part; null for parts of the box. */
  readonly assembly: string | null;
  readonly size: Vec3;
  readonly shape: CabinetShape;
  readonly origin: Vec3;
  readonly x: Vec3;
  readonly y: Vec3;
  readonly z: Vec3;
  readonly role: CabinetRole;
  /** The local +z face shows the finish, on a finished end. */
  readonly finishedOutside: boolean;
}

export interface CabinetPlan {
  readonly name: string;
  readonly at: Vec3;
  readonly used: CabinetUsed;
  readonly parts: readonly CabinetPart[];
}

/** Parameters that cannot make a cabinet; `code` says whether they contradict each other or cannot make sound parts. */
export class CabinetPlanError extends Error {
  constructor(readonly code: 'invalid_operation' | 'invalid_geometry', message: string) { super(message); this.name = 'CabinetPlanError'; }
}
const contradiction = (message: string): CabinetPlanError => new CabinetPlanError('invalid_operation', message);
const unsound = (message: string): CabinetPlanError => new CabinetPlanError('invalid_geometry', message);

type Axis = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';
const AXES: Record<Axis, Vec3> = { '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '-y': [0, -1, 0], '+z': [0, 0, 1], '-z': [0, 0, -1] };
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

interface Range { readonly from: number; readonly to: number }
const range = (from: number, to: number): Range => ({ from, to });
const span = (r: Range): number => r.to - r.from;
const inch = (m: number): string => `${Math.round((m / 0.0254) * 100) / 100} in`;

type Pt = readonly [number, number];
interface PartOptions { readonly cuts?: readonly CutBox[]; readonly rings?: readonly PanelRing[]; readonly finishedOutside?: boolean }

class Builder {
  constructor(readonly parts: CabinetPart[] = [], private readonly face: { readonly at: Pt; readonly u: Pt } | null = null) {}

  /** A builder whose x runs from `p` to `q` and whose y is 0 on that line, with -y facing out of the cabinet. */
  onFace(p: Pt, q: Pt): Builder {
    const dx = q[0] - p[0], dy = q[1] - p[1], length = Math.hypot(dx, dy);
    return new Builder(this.parts, { at: p, u: [dx / length, dy / length] });
  }

  private place(v: Vec3): Vec3 {
    if (!this.face) return v;
    const { u } = this.face;
    return [v[0] * u[0] - v[1] * u[1], v[0] * u[1] + v[1] * u[0], v[2]];
  }

  /** Add the part filling a box of this builder's space, with its length and width along the given axes. */
  add(name: string, assembly: string | null, role: CabinetRole, x: Range, y: Range, z: Range, length: Axis, width: Axis, options: PartOptions = {}): void {
    const extent: Vec3 = [span(x), span(y), span(z)];
    const lo: Vec3 = [x.from, y.from, z.from], hi: Vec3 = [x.to, y.to, z.to];
    const u = AXES[length], v = AXES[width], n = cross(u, v);
    const along = (axis: Vec3): number => Math.abs(axis[0] * extent[0] + axis[1] * extent[1] + axis[2] * extent[2]);
    const local = [0, 1, 2].map(i => (u[i]! + v[i]! + n[i]! < 0 ? hi[i]! : lo[i]!)) as unknown as Vec3;
    const rotated = this.place(local);
    const origin: Vec3 = this.face ? [rotated[0] + this.face.at[0], rotated[1] + this.face.at[1], rotated[2]] : local;
    this.parts.push({
      name, assembly, role, size: [along(u), along(v), along(n)],
      shape: options.rings ? { kind: 'lofted', rings: options.rings } : { kind: 'stock', cuts: options.cuts ?? [] },
      origin, x: this.place(u), y: this.place(v), z: this.place(n), finishedOutside: options.finishedOutside ?? false,
    });
  }

  /** Add a flat part with a counter-clockwise outline given in the cabinet's coordinates. */
  addOutline(name: string, role: CabinetRole, outline: readonly Pt[], z: Range, round = false): void {
    const minX = Math.min(...outline.map(p => p[0])), minY = Math.min(...outline.map(p => p[1]));
    const local = outline.map(([x, y]) => [x - minX, y - minY] as const);
    const size: Vec3 = [Math.max(...local.map(p => p[0])), Math.max(...local.map(p => p[1])), span(z)];
    this.parts.push({ name, assembly: null, role, size, shape: { kind: 'prism', outline: local, round }, origin: [minX, minY, z.from], x: AXES['+x'], y: AXES['+y'], z: AXES['+z'], finishedOutside: false });
  }
}

function groove(length: number, width: number): CutBox {
  return { min: [0, width - D.GROOVE_DEPTH, D.GROOVE_SHOULDER], max: [length, width, D.GROOVE_SHOULDER + D.GROOVE_WIDTH] };
}

/** Sections of a door's panel, back to front: relief behind, a tongue for the groove, a bevel up to the field. */
function raisedRings(): PanelRing[] {
  const back = (D.RAISED_PANEL - D.RAISED_TONGUE) / 2;
  const front = back + D.RAISED_TONGUE;
  return [[D.RAISED_RELIEF, 0], [D.RAISED_RELIEF, back], [0, back], [0, front], [D.RAISED_RELIEF, front], [D.RAISED_RELIEF + D.RAISED_BEVEL, D.RAISED_PANEL]];
}

type FrontStyle = 'slab' | 'shaker' | 'raised' | 'glass';
interface Rect { readonly x: Range; readonly z: Range }

/** A door or drawer front at `rect`, whose back is at y = back and whose face is toward -y. */
function addFront(b: Builder, assembly: string, rect: Rect, front: number, style: FrontStyle, horizontalPanel: boolean, slabName: string): void {
  const y = range(front, front + D.STOCK);
  if (style === 'slab') {
    if (horizontalPanel) b.add(slabName, assembly, 'show', rect.x, y, rect.z, '+x', '+z');
    else b.add(slabName, assembly, 'show', rect.x, y, rect.z, '+z', '+x');
    return;
  }
  const { x, z } = rect;
  const open: Rect = { x: range(x.from + D.STILE, x.to - D.STILE), z: range(z.from + D.STILE, z.to - D.STILE) };
  const height = span(z), railLength = span(open.x);
  // A member's thickness runs back from the face when `backIsFar`, and forward from the back otherwise.
  const edge = (length: number, backIsFar: boolean): CutBox[] => style !== 'glass' ? [groove(length, D.STILE)]
    : [{ min: [0, D.STILE - D.GLASS_RABBET, backIsFar ? D.STOCK - D.GLASS_RABBET : 0], max: [length, D.STILE, backIsFar ? D.STOCK : D.GLASS_RABBET] }];
  b.add('Left Stile', assembly, 'show', range(x.from, open.x.from), y, z, '+z', '+x', { cuts: edge(height, true) });
  b.add('Right Stile', assembly, 'show', range(open.x.to, x.to), y, z, '+z', '-x', { cuts: edge(height, false) });
  b.add('Top Rail', assembly, 'show', open.x, y, range(open.z.to, z.to), '+x', '-z', { cuts: edge(railLength, true) });
  b.add('Bottom Rail', assembly, 'show', open.x, y, range(z.from, open.z.from), '+x', '+z', { cuts: edge(railLength, false) });
  const into = D.GROOVE_DEPTH - D.PANEL_CLEARANCE / 2;
  const px = range(open.x.from - into, open.x.to + into), pz = range(open.z.from - into, open.z.to + into);
  if (style === 'glass') {
    const gy = range(front + D.STOCK - D.GLASS_RABBET, front + D.STOCK - D.GLASS_RABBET + D.GLASS);
    b.add('Glass', assembly, 'glass', px, gy, pz, '+z', '+x');
    return;
  }
  if (style === 'raised') {
    // The tongue is centered in the groove, so the panel is centered on the frame's thickness.
    const py = range(front + (D.STOCK - D.RAISED_PANEL) / 2, front + (D.STOCK + D.RAISED_PANEL) / 2);
    const rings = raisedRings();
    if (horizontalPanel) b.add('Panel', assembly, 'show', px, py, pz, '+x', '+z', { rings });
    else b.add('Panel', assembly, 'show', px, py, pz, '+z', '-x', { rings });
    return;
  }
  const py = range(front + D.GROOVE_SHOULDER, front + D.GROOVE_SHOULDER + D.PANEL);
  if (horizontalPanel) b.add('Panel', assembly, 'show', px, py, pz, '+x', '+z');
  else b.add('Panel', assembly, 'show', px, py, pz, '+z', '+x');
}

function minRaisedPanelOpening(): number {
  return 2 * (D.RAISED_RELIEF + D.RAISED_BEVEL) - 2 * (D.GROOVE_DEPTH - D.PANEL_CLEARANCE / 2) + D.MIN_PANEL_OPENING / 2;
}

function checkFive(style: FrontStyle, width: number, height: number, what: string): void {
  if (style === 'slab') {
    if (width < D.MIN_SLAB || height < D.MIN_SLAB) throw unsound(`${what} would be ${inch(width)} by ${inch(height)}, too small to make.`);
    return;
  }
  const openW = width - 2 * D.STILE, openH = height - 2 * D.STILE;
  const least = style === 'raised' ? minRaisedPanelOpening() : D.MIN_PANEL_OPENING;
  if (openW < least || openH < least)
    throw unsound(`${what} would be ${inch(width)} by ${inch(height)}, too small for ${style === 'raised' ? 'a raised panel' : 'its stiles, rails and panel'}.`);
}

type RowKind = 'drawer' | 'door' | 'sink';
interface Row { readonly kind: RowKind; readonly opening: Range; readonly front: Range; readonly name: string; readonly section: 'upper' | 'lower' | null }

/** Graduated proportions of a cabinet of only drawers, top row first. */
const GRADUATED: Readonly<Record<number, readonly number[]>> = { 1: [1], 2: [2, 3], 3: [6, 9, 12], 4: [5, 6, 8, 11] };

/** A section of a front plane: its full opening and, on each side, whether that edge is the cabinet's outer edge. */
interface FrontPlane {
  readonly builder: Builder;
  readonly width: number;
  readonly opening: Range;
  readonly doors: number;
  readonly names?: readonly string[];
  readonly outerLeft: boolean;
  readonly outerRight: boolean;
  readonly frame: { readonly assembly: string; readonly width: number; readonly leftStile: number; readonly rightStile: number; readonly blindStile?: Range } | null;
}

function arc(center: Pt, radius: number, fromDeg: number, toDeg: number, segments: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < segments; i++) {
    const a = ((fromDeg + ((toDeg - fromDeg) * i) / segments) * Math.PI) / 180;
    out.push([center[0] + radius * Math.cos(a), center[1] + radius * Math.sin(a)]);
  }
  return out;
}

export function planCabinet(p: CabinetParams): CabinetPlan {
  const type = p.type, width = p.width;
  const height = p.height ?? D.DEFAULT_HEIGHT[type], depth = p.depth ?? D.DEFAULT_DEPTH[type];
  const steer = 'Build this cabinet with add_box and the other operations instead.';
  const fix = steer.charAt(0).toLowerCase() + steer.slice(1);
  for (const [label, value, [low, high]] of [['Width', width, D.WIDTH_RANGE], ['Height', height, D.HEIGHT_RANGE], ['Depth', depth, D.DEPTH_RANGE]] as const)
    if (value < low - 1e-9 || value > high + 1e-9) throw unsound(`${label} ${inch(value)} is outside the ${inch(low)} to ${inch(high)} a standard cabinet takes. ${steer}`);

  const cornerStyle = p.corner?.style ?? null;
  const side: CabinetSide = p.corner?.side ?? 'left';
  const planned = cornerStyle === 'diagonal' || cornerStyle === 'l_shaped';
  const lazySusan = p.corner?.lazySusan ?? false;
  const returnWidth = planned ? p.corner?.returnWidth ?? width : undefined;
  if (p.corner) {
    if (cornerStyle === 'blind' && p.corner.returnWidth !== undefined) throw contradiction('returnWidth is for diagonal and L-shaped corners; a blind corner is a rectangular box.');
    if (cornerStyle !== 'blind' && p.corner.blindWidth !== undefined) throw contradiction('blindWidth is for a blind corner.');
    if (lazySusan && !planned) throw contradiction('lazySusan is for diagonal and L-shaped corners.');
    if (lazySusan && Math.abs(returnWidth! - width) > 1e-6) throw contradiction('A lazy Susan needs returnWidth equal to width.');
    if (planned && (p.sinkFront || (p.drawers ?? 0) > 0)) throw contradiction('Diagonal and L-shaped corner cabinets have no drawers or sink front; remove them.');
    if (cornerStyle === 'l_shaped' && p.doors !== undefined && p.doors !== 0 && p.doors !== 2) throw contradiction('An L-shaped corner has one door on each face: use doors 2, or 0 for open.');
    if (returnWidth !== undefined && (returnWidth < D.WIDTH_RANGE[0] - 1e-9 || returnWidth > D.WIDTH_RANGE[1] + 1e-9))
      throw unsound(`Return width ${inch(returnWidth)} is outside the ${inch(D.WIDTH_RANGE[0])} to ${inch(D.WIDTH_RANGE[1])} a standard cabinet takes. ${steer}`);
  }

  const frame = p.frame ?? 'frameless';
  const faceFrame = frame === 'face_frame';
  const overlay = p.overlay ?? (faceFrame ? 'partial' : 'full');
  if (!faceFrame && overlay !== 'full') throw contradiction(`A frameless cabinet takes full overlay doors only; "${overlay}" needs frame: "face_frame".`);

  const blindWidth = cornerStyle === 'blind' ? p.corner?.blindWidth ?? width - D.DEFAULT_BLIND_DOOR : undefined;
  if (blindWidth !== undefined && (blindWidth < D.MIN_BLIND - 1e-9 || width - blindWidth < D.MIN_CORNER_FACE - 1e-9))
    throw unsound(`A blind width of ${inch(blindWidth)} on a ${inch(width)} cabinet must be at least ${inch(D.MIN_BLIND)} and leave ${inch(D.MIN_CORNER_FACE)} open. ${steer}`);

  // The plan of a diagonal or L-shaped corner, drawn for a left corner: walls at x = 0 and y = Y, then mirrored for a right one.
  const X = width, Y = returnWidth ?? 0, d = depth;
  const flipped = side === 'right';
  const mx = (pt: Pt): Pt => (flipped ? [X - pt[0], pt[1]] : pt);
  const mxRange = (r: Range): Range => (flipped ? range(X - r.to, X - r.from) : r);
  const outlineOf = (pts: Pt[]): Pt[] => (flipped ? pts.map(mx).reverse() : pts);
  if (planned && (X - d < D.MIN_CORNER_FACE - 1e-9 || Y - d < D.MIN_CORNER_FACE - 1e-9))
    throw unsound(`A corner ${inch(X)} by ${inch(Y)} with ${inch(d)} deep wings leaves less than ${inch(D.MIN_CORNER_FACE)} for a face. ${steer}`);
  const D0: Pt = [d, 0], C0: Pt = [X, Y - d];
  const diagonalLength = cornerStyle === 'diagonal' ? Math.hypot(C0[0] - D0[0], C0[1] - D0[1]) : 0;

  const doorStyle = p.doorStyle ?? 'shaker';
  if (doorStyle === 'none' && (p.doors ?? 0) > 0) throw contradiction('doorStyle "none" builds no doors; remove doors or choose a door style.');
  const defaultDoorSpan = cornerStyle === 'diagonal' ? diagonalLength : blindWidth !== undefined ? width - blindWidth : width;
  const doors = doorStyle === 'none' ? 0 : cornerStyle === 'l_shaped' ? p.doors ?? 2 : p.doors ?? (defaultDoorSpan <= D.SINGLE_DOOR_UP_TO + 1e-9 ? 1 : 2);

  if (type === 'wall' && p.toeKick === true) throw contradiction('A wall cabinet has no toe kick; remove toeKick.');
  const toeKick = type === 'wall' ? false : p.toeKick ?? true;

  const stackedDoors = p.stackedDoors ?? false;
  if (stackedDoors && type === 'base') throw contradiction('Stacked doors are for wall and tall cabinets.');
  if (stackedDoors && doors === 0) throw contradiction('stackedDoors needs doors; choose a door style and at least one door.');
  if (!stackedDoors && (p.upperDoorHeight !== undefined || p.upperDoorStyle !== undefined)) throw contradiction('upperDoorHeight and upperDoorStyle need stackedDoors: true.');
  if (p.upperDoorStyle === 'none') throw contradiction('upperDoorStyle takes a door style; "none" builds no door.');

  const sinkFront = p.sinkFront ?? false;
  if (sinkFront && (type !== 'base' || doors === 0)) throw contradiction('sinkFront is for a base cabinet with doors below it.');
  const drawers = p.drawers ?? (planned ? 0 : sinkFront ? 1 : type === 'base' ? (doors === 0 ? 3 : 1) : 0);
  if (sinkFront && drawers !== 1) throw contradiction('sinkFront replaces the single drawer row; use drawers: 1 or leave it out.');

  const noDoorSection = doors === 0 && drawers > 0;
  const shelfDefault = lazySusan ? (type === 'tall' ? 4 : 2) : noDoorSection ? 0 : type === 'base' ? 1 : type === 'tall' ? 4 : height >= D.inches(42) - 1e-9 ? 3 : height >= D.inches(30) - 1e-9 ? 2 : 1;
  const shelves = p.shelves ?? shelfDefault;
  if (noDoorSection && shelves > 0) throw contradiction('This cabinet is all drawers, so it has no room for shelves; remove shelves or add a door section.');

  if (p.finish?.paint !== undefined && p.finish.stain !== undefined) throw contradiction('finish takes paint or stain, not both.');
  const finish: CabinetFinish = p.finish?.stain !== undefined ? { stain: p.finish.stain } : { paint: p.finish?.paint ?? D.DEFAULT_PAINT };
  const back = p.back ?? true, drawerBoxes = p.drawerBoxes ?? true, finishedEnds = p.finishedEnds ?? 'none';
  const at: Vec3 = p.at ?? (type === 'wall' ? [0, 0, D.WALL_HANG_HEIGHT] : [0, 0, 0]);

  const t = D.STOCK, frameDepth = faceFrame ? t : 0, backT = back ? D.BACK : 0, floor = toeKick ? D.TOE_KICK_HEIGHT : 0;
  const b = new Builder();
  const interiorBack = depth - backT, topUnder = height - t;

  // Rows of fronts, top to bottom. A frameless cabinet treats each front as its own opening with no overlay.
  const outerTop = faceFrame ? D.FRAME_WIDTH : type === 'base' ? D.GAP : D.REVEAL;
  const outerBottom = faceFrame ? D.FRAME_WIDTH : D.REVEAL;
  const divider = faceFrame ? D.FRAME_WIDTH : D.GAP;
  const overlayAt = (outer: boolean): number => !faceFrame ? 0 : overlay === 'inset' ? -D.GAP / 2 : overlay === 'partial' ? D.PARTIAL_OVERLAY : outer ? D.FULL_OVERLAY : (D.FRAME_WIDTH - D.GAP) / 2;

  const doorRows = doors === 0 ? 0 : stackedDoors ? 2 : 1;
  const rowCount = drawers + doorRows;
  const drawersFirst = type !== 'tall';
  const kinds: { kind: RowKind; drawer: number; section: 'upper' | 'lower' | null }[] = [];
  const drawerKinds = Array.from({ length: drawers }, (_, i) => ({ kind: (sinkFront ? 'sink' : 'drawer') as RowKind, drawer: i + 1, section: null }));
  const doorKinds = doorRows === 2
    ? [{ kind: 'door' as RowKind, drawer: 0, section: 'upper' as const }, { kind: 'door' as RowKind, drawer: 0, section: 'lower' as const }]
    : doorRows === 1 ? [{ kind: 'door' as RowKind, drawer: 0, section: null }] : [];
  kinds.push(...(drawersFirst ? [...drawerKinds, ...doorKinds] : [...doorKinds, ...drawerKinds]));

  const rows: Row[] = [];
  let upperDoorHeight: number | undefined;
  if (rowCount > 0) {
    const available = height - floor - outerTop - outerBottom - divider * (rowCount - 1);
    const overlays = (i: number): number => overlayAt(i === 0) + overlayAt(i === rowCount - 1);
    const openings = new Array<number>(rowCount).fill(0);
    const isDrawer = (i: number): boolean => kinds[i]!.kind !== 'door';
    if (doors > 0) {
      kinds.forEach((_, i) => { if (isDrawer(i)) openings[i] = D.DRAWER_FRONT - overlays(i); });
      const drawerTotal = openings.reduce((a, c) => a + c, 0), doorTotal = available - drawerTotal;
      const doorIndexes = kinds.flatMap((k, i) => (k.kind === 'door' ? [i] : []));
      if (stackedDoors) {
        const u = doorIndexes[0]!, l = doorIndexes[1]!;
        const upper = p.upperDoorHeight !== undefined ? p.upperDoorHeight - overlays(u) : doorTotal * D.UPPER_DOOR_SHARE;
        openings[u] = upper;
        openings[l] = doorTotal - upper;
      } else openings[doorIndexes[0]!] = doorTotal;
      for (const i of doorIndexes) {
        const front = openings[i]! + overlays(i);
        if (front < D.MIN_DOOR_HEIGHT - 1e-9) throw unsound(`A door would be only ${inch(front)} tall in a ${inch(height)} cabinet. Change the drawers or door heights, or ${fix}`);
      }
    } else if (drawers > 0) {
      const weights = GRADUATED[drawers]!, total = weights.reduce((a, c) => a + c, 0);
      weights.forEach((w, i) => { openings[i] = (available * w) / total; });
    }
    let top = height - outerTop;
    openings.forEach((opening, i) => {
      const bottom = top - opening;
      const front = range(bottom - overlayAt(i === rowCount - 1), top + overlayAt(i === 0));
      const k = kinds[i]!;
      if (k.kind !== 'door' && span(front) < D.MIN_DRAWER_HEIGHT) throw unsound(`A drawer front would be ${inch(span(front))} tall. ${steer}`);
      if (k.section === 'upper') upperDoorHeight = span(front);
      const name = k.kind === 'door' ? (k.section === 'upper' ? 'Upper Door' : k.section === 'lower' ? 'Lower Door' : 'Door')
        : k.kind === 'sink' ? 'False Front' : drawers === 1 ? 'Drawer' : `Drawer ${k.drawer}`;
      rows.push({ kind: k.kind, opening: range(bottom, top), front, name, section: k.section });
      top = bottom - divider;
    });
  }

  const inset = overlay === 'inset';
  const frontY = inset ? 0 : -t;

  const addFrame = (plane: FrontPlane): void => {
    if (!plane.frame) return;
    const f = plane.frame, A = f.assembly, fy = range(0, t);
    const rail = range(f.leftStile, f.width - f.rightStile);
    plane.builder.add('Left Stile', A, 'show', range(0, f.leftStile), fy, range(floor, height), '+z', '+x');
    plane.builder.add('Right Stile', A, 'show', range(f.width - f.rightStile, f.width), fy, range(floor, height), '+z', '-x');
    plane.builder.add('Top Rail', A, 'show', rail, fy, range(height - D.FRAME_WIDTH, height), '+x', '-z');
    plane.builder.add('Bottom Rail', A, 'show', rail, fy, range(floor, floor + D.FRAME_WIDTH), '+x', '+z');
    rows.slice(1).forEach((row, i) => plane.builder.add(`Middle Rail ${i + 1}`, A, 'show', plane.opening, fy, range(row.opening.to, row.opening.to + D.FRAME_WIDTH), '+x', '+z'));
    if (f.blindStile) plane.builder.add('Blind Stile', A, 'show', f.blindStile, fy, range(floor + D.FRAME_WIDTH, height - D.FRAME_WIDTH), '+z', '+x');
    if (plane.doors === 2) {
      const mid = (plane.opening.from + plane.opening.to) / 2;
      rows.filter(r => r.kind === 'door').forEach((row, i, all) => plane.builder.add(all.length > 1 ? `Center Stile ${i + 1}` : 'Center Stile', A, 'show', range(mid - D.FRAME_WIDTH / 2, mid + D.FRAME_WIDTH / 2), fy, row.opening, '+z', '+x'));
    }
  };

  const expand = (open: Range, outerLeft: boolean, outerRight: boolean): Range => range(open.from - overlayAt(outerLeft), open.to + overlayAt(outerRight));
  const doorStyleOf = (row: Row): FrontStyle => {
    const style = row.section === 'upper' ? p.upperDoorStyle ?? doorStyle : doorStyle;
    return style === 'none' ? 'slab' : style;
  };

  const addFronts = (plane: FrontPlane): void => {
    const { builder, opening: full } = plane;
    for (const row of rows) {
      if (row.kind === 'door') {
        const style = doorStyleOf(row);
        const prefix = row.section === 'upper' ? 'Upper ' : row.section === 'lower' ? 'Lower ' : '';
        const mid = (full.from + full.to) / 2, half = (faceFrame ? D.FRAME_WIDTH : D.GAP) / 2;
        const leaves: { name: string; x: Range; outerLeft: boolean; outerRight: boolean }[] = plane.doors === 1
          ? [{ name: `${prefix}${plane.names?.[0] ?? 'Door'}`, x: full, outerLeft: plane.outerLeft, outerRight: plane.outerRight }]
          : [{ name: `${prefix}Left Door`, x: range(full.from, mid - half), outerLeft: plane.outerLeft, outerRight: false }, { name: `${prefix}Right Door`, x: range(mid + half, full.to), outerLeft: false, outerRight: plane.outerRight }];
        for (const leaf of leaves) {
          const x = expand(leaf.x, leaf.outerLeft, leaf.outerRight);
          checkFive(style, span(x), span(row.front), leaf.name);
          addFront(builder, leaf.name, { x, z: row.front }, frontY, style, false, 'Slab');
        }
        continue;
      }
      const x = expand(full, plane.outerLeft, plane.outerRight);
      if (row.kind === 'sink') {
        builder.add('False Front', null, 'show', x, range(frontY, frontY + t), row.front, '+x', '+z');
        continue;
      }
      const tall = span(row.front) >= D.SLAB_DRAWER_BELOW - 1e-9;
      const wanted: FrontStyle = !tall || doorStyle === 'none' ? 'slab' : doorStyle === 'glass' ? 'shaker' : doorStyle;
      const raisedFits = span(x) - 2 * D.STILE >= minRaisedPanelOpening() && span(row.front) - 2 * D.STILE >= minRaisedPanelOpening();
      const style: FrontStyle = wanted === 'raised' && !raisedFits ? 'shaker' : wanted;
      checkFive(style, span(x), span(row.front), row.name);
      addFront(builder, row.name, { x, z: row.front }, frontY, style, true, 'Front');
      if (!drawerBoxes) continue;

      const between = faceFrame ? full : range(Math.max(t, full.from - D.REVEAL), Math.min(width - t, full.to + D.REVEAL));
      const bx = range(between.from + D.DRAWER_SLIDES / 2, between.to - D.DRAWER_SLIDES / 2);
      const startY = inset ? t : 0, endY = interiorBack - D.DRAWER_CLEARANCE;
      const lowest = Math.max(row.opening.from + (faceFrame ? D.DRAWER_CLEARANCE / 2 : D.DRAWER_CLEARANCE), floor + t + D.DRAWER_CLEARANCE / 2);
      const highest = Math.min(row.opening.to - (faceFrame ? D.DRAWER_CLEARANCE / 2 : D.DRAWER_CLEARANCE), topUnder - D.DRAWER_CLEARANCE / 2);
      if (highest - lowest < D.MIN_DRAWER_HEIGHT || endY - startY < D.MIN_DRAWER_LENGTH) throw unsound(`${row.name} leaves no room for a drawer box. Set drawerBoxes to false, or ${fix}`);
      const bz = range(lowest, highest), by = range(startY, endY), s = D.DRAWER_SIDE, A = row.name;
      b.add('Box Left Side', A, 'box', range(bx.from, bx.from + s), by, bz, '+y', '+z');
      b.add('Box Right Side', A, 'box', range(bx.to - s, bx.to), by, bz, '+y', '+z');
      const betweenSides = range(bx.from + s, bx.to - s);
      b.add('Box Front', A, 'box', betweenSides, range(by.from, by.from + s), bz, '+x', '+z');
      b.add('Box Back', A, 'box', betweenSides, range(by.to - s, by.to), bz, '+x', '+z');
      const bottomZ = range(bz.from + D.DRAWER_BOTTOM_INSET, bz.from + D.DRAWER_BOTTOM_INSET + D.DRAWER_BOTTOM);
      b.add('Box Bottom', A, 'box', betweenSides, range(by.from + s, by.to - s), bottomZ, '+x', '+y');
    }
  };

  const shelfHeights = (region: Range): number[] => {
    if (shelves === 0) return [];
    const free = span(region) - shelves * t, spacing = free / (shelves + 1);
    if (spacing < D.MIN_SHELF_SPACE) throw unsound(`${shelves} shelves do not fit in ${inch(span(region))} of height. Use fewer shelves, or ${fix}`);
    return Array.from({ length: shelves }, (_, i) => region.from + spacing * (i + 1) + t * i);
  };

  if (planned) {
    // A left corner is drawn here; `mx` and `outlineOf` mirror each result for a right corner.
    const unit: Pt = [(C0[0] - D0[0]) / (diagonalLength || 1), (C0[1] - D0[1]) / (diagonalLength || 1)];
    const inward: Pt = [-unit[1], unit[0]];
    const lineX = (offset: number, y: number): number => {
      const px = D0[0] + inward[0] * offset, py = D0[1] + inward[1] * offset;
      return px + ((y - py) * unit[0]) / unit[1];
    };
    const lineY = (offset: number, x: number): number => {
      const px = D0[0] + inward[0] * offset, py = D0[1] + inward[1] * offset;
      return py + ((x - px) * unit[1]) / unit[0];
    };
    const diagonal = cornerStyle === 'diagonal';
    const outline = (setback: number, sideClear: number, backClear: number): Pt[] => {
      const wall = backT + backClear, end = t + sideClear;
      return outlineOf(diagonal
        ? [[wall, end], [lineX(setback, end), end], [X - end, lineY(setback, X - end)], [X - end, Y - wall], [wall, Y - wall]]
        : [[wall, end], [d - setback, end], [d - setback, Y - d + setback], [X - end, Y - d + setback], [X - end, Y - wall], [wall, Y - wall]]);
    };

    // The wing ends stop behind any face frame and are notched back to the toe kick.
    const backWingFront = diagonal ? lineY(frameDepth, X) : Y - d + frameDepth;
    const sideWingFront = diagonal ? lineX(frameDepth, 0) : d - frameDepth;
    const backNotch = diagonal ? lineY(D.TOE_KICK_DEPTH, X - t) - backWingFront : D.TOE_KICK_DEPTH - frameDepth;
    const sideNotch = diagonal ? sideWingFront - lineX(D.TOE_KICK_DEPTH, t) : D.TOE_KICK_DEPTH - frameDepth;
    const backSpan = Y - backWingFront, sideSpan = sideWingFront;
    const notchAt = (w: Range): CutBox[] => (toeKick ? [{ min: [0, w.from, 0], max: [D.TOE_KICK_HEIGHT, w.to, t] }] : []);
    const z = range(0, height);
    const backFinished = finishedEnds === 'both' || finishedEnds === (flipped ? 'left' : 'right');
    const sideFinished = finishedEnds === 'both' || finishedEnds === (flipped ? 'right' : 'left');
    if (!flipped) {
      b.add('Back Wing Side', null, 'box', range(X - t, X), range(backWingFront, Y), z, '+z', '-y', { cuts: notchAt(range(backSpan - backNotch, backSpan)), finishedOutside: backFinished });
      b.add('Left Wing Side', null, 'box', range(0, sideWingFront), range(0, t), z, '+z', '-x', { cuts: notchAt(range(0, sideNotch)), finishedOutside: sideFinished });
    } else {
      b.add('Back Wing Side', null, 'box', range(0, t), range(backWingFront, Y), z, '+z', '+y', { cuts: notchAt(range(0, backNotch)), finishedOutside: backFinished });
      b.add('Right Wing Side', null, 'box', range(X - sideWingFront, X), range(0, t), z, '+z', '-x', { cuts: notchAt(range(sideSpan - sideNotch, sideSpan)), finishedOutside: sideFinished });
    }
    const rise = range(floor, height);
    if (back) {
      b.add('Back', null, 'box', mxRange(range(0, X - t)), range(Y - backT, Y), rise, '+z', '+x');
      b.add(flipped ? 'Right Back' : 'Left Back', null, 'box', mxRange(range(0, backT)), range(t, Y - backT), rise, '+z', '+y');
    }
    const carcass = outline(frameDepth, 0, 0);
    b.addOutline('Bottom', 'box', carcass, range(floor, floor + t));
    b.addOutline('Top', 'box', carcass, range(topUnder, height));

    const face = (pIn: Pt, qIn: Pt): Builder => (flipped ? b.onFace(mx(qIn), mx(pIn)) : b.onFace(pIn, qIn));
    if (toeKick) {
      if (diagonal) {
        const pIn: Pt = [lineX(D.TOE_KICK_DEPTH, t), t], qIn: Pt = [X - t, lineY(D.TOE_KICK_DEPTH, X - t)];
        face(pIn, qIn).add('Toe Kick', null, 'show', range(0, Math.hypot(qIn[0] - pIn[0], qIn[1] - pIn[1])), range(0, t), range(0, floor), '+x', '+z');
      } else {
        const r = D.TOE_KICK_DEPTH, cornerX = d - r, cornerY = Y - d + r;
        face([cornerX, cornerY], [X - t, cornerY]).add('Front Toe Kick', null, 'show', range(0, X - t - cornerX), range(0, t), range(0, floor), '+x', '+z');
        face([cornerX, t], [cornerX, cornerY + t]).add('Side Toe Kick', null, 'show', range(0, cornerY), range(0, t), range(0, floor), '+x', '+z');
      }
    }

    const FW = D.FRAME_WIDTH;
    if (diagonal) {
      const builder = face(D0, C0), W = diagonalLength;
      const plane: FrontPlane = {
        builder, width: W, doors, outerLeft: true, outerRight: true,
        opening: faceFrame ? range(FW, W - FW) : range(D.REVEAL, W - D.REVEAL),
        frame: faceFrame ? { assembly: 'Face Frame', width: W, leftStile: FW, rightStile: FW } : null,
      };
      addFrame(plane);
      addFronts(plane);
    } else {
      // The two faces meet at the inside corner: the front face's door clears the side face's door.
      const WA = X - d, WB = Y - d;
      const front: FrontPlane = {
        builder: face([d, Y - d], [X, Y - d]), width: WA, doors: doors > 0 ? 1 : 0, names: ['Front Door'], outerLeft: flipped, outerRight: !flipped,
        opening: faceFrame ? range(FW, WA - FW) : flipped ? range(D.REVEAL, WA - t - D.GAP) : range(t + D.GAP, WA - D.REVEAL),
        frame: faceFrame ? { assembly: 'Front Face Frame', width: WA, leftStile: FW, rightStile: FW } : null,
      };
      const sideFrameWidth = WB + frameDepth;
      const sideFace: FrontPlane = {
        builder: face([d, 0], [d, Y - d]), width: WB, doors: doors > 0 ? 1 : 0, names: ['Side Door'], outerLeft: !flipped, outerRight: flipped,
        opening: range(D.REVEAL, WB - D.REVEAL),
        frame: null,
      };
      addFrame(front);
      addFronts(front);
      if (faceFrame) {
        const sideFrameFace = flipped ? b.onFace(mx([d, Y - d + frameDepth]), mx([d, 0])) : b.onFace([d, 0], [d, Y - d + frameDepth]);
        addFrame({ ...sideFace, builder: sideFrameFace, width: sideFrameWidth, frame: { assembly: 'Side Face Frame', width: sideFrameWidth, leftStile: FW, rightStile: FW }, opening: range(FW, sideFrameWidth - FW) });
        addFronts({ ...sideFace, builder: sideFrameFace, width: sideFrameWidth, opening: range(FW, sideFrameWidth - FW) });
      } else addFronts(sideFace);
    }

    const region = rows.length ? range(Math.max(rows[rows.length - 1]!.opening.from, floor + t), Math.min(rows[0]!.opening.to, topUnder)) : range(floor + t, topUnder);
    const heights = shelfHeights(region);
    if (lazySusan) {
      const setback = frameDepth + D.SHELF_SETBACK, wall = backT + D.SHELF_BACK_CLEARANCE;
      let tray: Pt[];
      if (diagonal) {
        const toFront = Math.abs((wall - D0[0]) * inward[0] + (Y - wall - D0[1]) * inward[1]) - setback;
        const radius = toFront / (1 + Math.SQRT2);
        tray = arc([wall + radius, Y - wall - radius], radius, 0, 360, D.TRAY_SEGMENTS);
      } else {
        const center: Pt = [d - setback, Y - d + setback];
        const end = t + D.SHELF_BACK_CLEARANCE;
        const radius = Math.min(center[0] - wall, Y - wall - center[1], X - end - center[0], center[1] - end);
        tray = [center, ...arc(center, radius, 0, 270, D.TRAY_SEGMENTS - 12), [center[0], center[1] - radius]];
      }
      heights.forEach((bottom, i) => b.addOutline(shelves === 1 ? 'Lazy Susan' : `Lazy Susan ${i + 1}`, 'box', outlineOf(tray), range(bottom, bottom + t), true));
    } else {
      const shelf = outline(frameDepth + D.SHELF_SETBACK, D.SHELF_SIDE_CLEARANCE, D.SHELF_BACK_CLEARANCE);
      heights.forEach((bottom, i) => b.addOutline(shelves === 1 ? 'Shelf' : `Shelf ${i + 1}`, 'box', shelf, range(bottom, bottom + t)));
    }
  } else {
    // A rectangular box.
    const sideLength = height, sideWidth = depth - frameDepth;
    const notchDepth = D.TOE_KICK_DEPTH - frameDepth;
    const rabbet = (w: Range): CutBox => ({ min: [0, w.from, 0], max: [sideLength, w.to, D.BACK_RABBET] });
    const notch = (w: Range): CutBox => ({ min: [0, w.from, 0], max: [D.TOE_KICK_HEIGHT, w.to, t] });
    const cutsFor = (notchAt: Range, rabbetAt: Range): CutBox[] => [...(toeKick ? [notch(notchAt)] : []), ...(back ? [rabbet(rabbetAt)] : [])];
    const y = range(frameDepth, depth), z = range(0, height);
    b.add('Left Side', null, 'box', range(0, t), y, z, '+z', '+y', {
      cuts: cutsFor(range(0, notchDepth), range(sideWidth - backT, sideWidth)), finishedOutside: finishedEnds === 'left' || finishedEnds === 'both',
    });
    b.add('Right Side', null, 'box', range(width - t, width), y, z, '+z', '-y', {
      cuts: cutsFor(range(sideWidth - notchDepth, sideWidth), range(0, backT)), finishedOutside: finishedEnds === 'right' || finishedEnds === 'both',
    });
    const insideX = range(t, width - t), insideY = range(frameDepth, interiorBack);
    b.add('Bottom', null, 'box', insideX, insideY, range(floor, floor + t), '+x', '+y');
    if (type === 'base') {
      b.add('Front Stretcher', null, 'box', insideX, range(frameDepth, frameDepth + D.STRETCHER), range(topUnder, height), '+x', '+y');
      b.add('Rear Stretcher', null, 'box', insideX, range(interiorBack - D.STRETCHER, interiorBack), range(topUnder, height), '+x', '+y');
    } else {
      b.add('Top', null, 'box', insideX, insideY, range(topUnder, height), '+x', '+y');
    }
    if (back) b.add('Back', null, 'box', range(t - D.BACK_RABBET, width - t + D.BACK_RABBET), range(interiorBack, depth), range(floor, height), '+z', '+x');
    if (toeKick) b.add('Toe Kick', null, 'show', insideX, range(D.TOE_KICK_DEPTH, D.TOE_KICK_DEPTH + t), range(0, floor), '+x', '+z');

    const FW = D.FRAME_WIDTH;
    const blindLeft = blindWidth !== undefined && side === 'left', blindRight = blindWidth !== undefined && side === 'right';
    const opening = faceFrame ? range(blindLeft ? blindWidth! : FW, width - (blindRight ? blindWidth! : FW))
      : range((blindLeft ? blindWidth! : 0) + D.REVEAL, width - (blindRight ? blindWidth! : 0) - D.REVEAL);
    const blindStile = !faceFrame ? undefined : blindLeft ? range(blindWidth! - FW, blindWidth!) : blindRight ? range(width - blindWidth!, width - blindWidth! + FW) : undefined;
    const plane: FrontPlane = { builder: b, width, opening, doors, outerLeft: true, outerRight: true, frame: faceFrame ? { assembly: 'Face Frame', width, leftStile: FW, rightStile: FW, ...(blindStile ? { blindStile } : {}) } : null };
    addFrame(plane);
    addFronts(plane);

    if (blindWidth !== undefined && !faceFrame && rows.length) {
      const x = blindLeft ? range(D.REVEAL, blindWidth - D.REVEAL) : range(width - blindWidth + D.REVEAL, width - D.REVEAL);
      const z = range(rows[rows.length - 1]!.front.from, rows[0]!.front.to), y = range(-t, 0), A = 'Blind Frame';
      const inner = range(x.from + D.STILE, x.to - D.STILE);
      if (span(inner) < D.MIN_PANEL_OPENING) throw unsound(`A blind width of ${inch(blindWidth)} is too narrow for its frame. ${steer}`);
      b.add(blindLeft ? 'Outer Stile' : 'Inner Stile', A, 'show', range(x.from, inner.from), y, z, '+z', '+x');
      b.add(blindLeft ? 'Inner Stile' : 'Outer Stile', A, 'show', range(inner.to, x.to), y, z, '+z', '-x');
      b.add('Top Rail', A, 'show', inner, y, range(z.to - D.STILE, z.to), '+x', '-z');
      b.add('Bottom Rail', A, 'show', inner, y, range(z.from, z.from + D.STILE), '+x', '+z');
    }

    const doorSections = rows.filter(r => r.kind === 'door');
    const region = doorSections.length ? range(Math.max(doorSections[doorSections.length - 1]!.opening.from, floor + t), Math.min(doorSections[0]!.opening.to, topUnder)) : range(floor + t, topUnder);
    const sx = range(t + D.SHELF_SIDE_CLEARANCE, width - t - D.SHELF_SIDE_CLEARANCE);
    const sy = range(frameDepth + D.SHELF_SETBACK, interiorBack - D.SHELF_BACK_CLEARANCE);
    shelfHeights(region).forEach((bottom, i) => b.add(shelves === 1 ? 'Shelf' : `Shelf ${i + 1}`, null, 'box', sx, sy, range(bottom, bottom + t), '+x', '+y'));
  }

  const used: CabinetUsed = {
    type, width, height, depth, at, frame, overlay, doorStyle, doors, drawers, drawerBoxes, sinkFront, shelves, toeKick, back, finish, finishedEnds, stackedDoors,
    ...(stackedDoors ? { upperDoorHeight: upperDoorHeight!, upperDoorStyle: p.upperDoorStyle ?? doorStyle } : {}),
    ...(cornerStyle ? { corner: { style: cornerStyle, side, lazySusan, ...(returnWidth !== undefined ? { returnWidth } : {}), ...(blindWidth !== undefined ? { blindWidth } : {}) } } : {}),
  };
  const typeName = type === 'base' ? 'Base' : type === 'wall' ? 'Wall' : 'Tall';
  return { name: p.name ?? `${typeName} ${cornerStyle ? 'Corner ' : ''}Cabinet ${inch(width)}`, at, used, parts: b.parts };
}
