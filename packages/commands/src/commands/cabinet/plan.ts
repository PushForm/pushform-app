// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Vec3 } from '@pushform/core';
import type { CutBox, PanelRing } from './mesh';
import * as D from './dimensions';

export type CabinetType = 'base' | 'wall' | 'tall';
export type CabinetFrame = 'frameless' | 'face_frame';
export type CabinetOverlay = 'full' | 'partial' | 'inset';
export type CabinetDoorStyle = 'slab' | 'shaker' | 'raised' | 'none';
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
}

export type CabinetShape = { readonly kind: 'stock'; readonly cuts: readonly CutBox[] } | { readonly kind: 'lofted'; readonly rings: readonly PanelRing[] };

/** One solid. Its local axes are x along its length and grain, y across its width and z through its thickness. */
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
  readonly role: 'box' | 'show';
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

interface PartOptions { readonly cuts?: readonly CutBox[]; readonly rings?: readonly PanelRing[]; readonly finishedOutside?: boolean }

class Builder {
  readonly parts: CabinetPart[] = [];

  /** Add the part filling a box of the cabinet, with its length and width along the given axes. */
  add(name: string, assembly: string | null, role: 'box' | 'show', x: Range, y: Range, z: Range, length: Axis, width: Axis, options: PartOptions = {}): void {
    const extent: Vec3 = [span(x), span(y), span(z)];
    const lo: Vec3 = [x.from, y.from, z.from], hi: Vec3 = [x.to, y.to, z.to];
    const u = AXES[length], v = AXES[width], n = cross(u, v);
    const along = (axis: Vec3): number => Math.abs(axis[0] * extent[0] + axis[1] * extent[1] + axis[2] * extent[2]);
    const origin = [0, 1, 2].map(i => (u[i]! + v[i]! + n[i]! < 0 ? hi[i]! : lo[i]!)) as unknown as Vec3;
    this.parts.push({
      name, assembly, role, size: [along(u), along(v), along(n)],
      shape: options.rings ? { kind: 'lofted', rings: options.rings } : { kind: 'stock', cuts: options.cuts ?? [] },
      origin, x: u, y: v, z: n, finishedOutside: options.finishedOutside ?? false,
    });
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

type FrontStyle = 'slab' | 'shaker' | 'raised';
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
  const stileCuts = [groove(height, D.STILE)], railCuts = [groove(railLength, D.STILE)];
  b.add('Left Stile', assembly, 'show', range(x.from, open.x.from), y, z, '+z', '+x', { cuts: stileCuts });
  b.add('Right Stile', assembly, 'show', range(open.x.to, x.to), y, z, '+z', '-x', { cuts: stileCuts });
  b.add('Top Rail', assembly, 'show', open.x, y, range(open.z.to, z.to), '+x', '-z', { cuts: railCuts });
  b.add('Bottom Rail', assembly, 'show', open.x, y, range(z.from, open.z.from), '+x', '+z', { cuts: railCuts });
  const into = D.GROOVE_DEPTH - D.PANEL_CLEARANCE / 2;
  const px = range(open.x.from - into, open.x.to + into), pz = range(open.z.from - into, open.z.to + into);
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

interface Row { readonly kind: 'drawer' | 'door' | 'sink'; readonly opening: Range; readonly front: Range; readonly name: string; readonly index: number }

/** Graduated proportions of a cabinet of only drawers, top row first. */
const GRADUATED: Readonly<Record<number, readonly number[]>> = { 1: [1], 2: [2, 3], 3: [6, 9, 12], 4: [5, 6, 8, 11] };

export function planCabinet(p: CabinetParams): CabinetPlan {
  const type = p.type, width = p.width;
  const height = p.height ?? D.DEFAULT_HEIGHT[type], depth = p.depth ?? D.DEFAULT_DEPTH[type];
  const steer = 'Build this cabinet with add_box and the other operations instead.';
  for (const [label, value, [low, high]] of [['Width', width, D.WIDTH_RANGE], ['Height', height, D.HEIGHT_RANGE], ['Depth', depth, D.DEPTH_RANGE]] as const)
    if (value < low - 1e-9 || value > high + 1e-9) throw unsound(`${label} ${inch(value)} is outside the ${inch(low)} to ${inch(high)} a standard cabinet takes. ${steer}`);

  const frame = p.frame ?? 'frameless';
  const faceFrame = frame === 'face_frame';
  const overlay = p.overlay ?? (faceFrame ? 'partial' : 'full');
  if (!faceFrame && overlay !== 'full') throw contradiction(`A frameless cabinet takes full overlay doors only; "${overlay}" needs frame: "face_frame".`);

  const doorStyle = p.doorStyle ?? 'shaker';
  if (doorStyle === 'none' && (p.doors ?? 0) > 0) throw contradiction('doorStyle "none" builds no doors; remove doors or choose a door style.');
  const doors = doorStyle === 'none' ? 0 : p.doors ?? (width <= D.SINGLE_DOOR_UP_TO + 1e-9 ? 1 : 2);

  if (type === 'wall' && p.toeKick === true) throw contradiction('A wall cabinet has no toe kick; remove toeKick.');
  const toeKick = type === 'wall' ? false : p.toeKick ?? true;

  const sinkFront = p.sinkFront ?? false;
  if (sinkFront && (type !== 'base' || doors === 0)) throw contradiction('sinkFront is for a base cabinet with doors below it.');
  const drawers = p.drawers ?? (sinkFront ? 1 : type === 'base' ? (doors === 0 ? 3 : 1) : 0);
  if (sinkFront && drawers !== 1) throw contradiction('sinkFront replaces the single drawer row; use drawers: 1 or leave it out.');

  const noDoorSection = doors === 0 && drawers > 0;
  const shelfDefault = noDoorSection ? 0 : type === 'base' ? 1 : type === 'tall' ? 4 : height >= D.inches(42) - 1e-9 ? 3 : height >= D.inches(30) - 1e-9 ? 2 : 1;
  const shelves = p.shelves ?? shelfDefault;
  if (noDoorSection && shelves > 0) throw contradiction('This cabinet is all drawers, so it has no room for shelves; remove shelves or add a door section.');

  if (p.finish?.paint !== undefined && p.finish.stain !== undefined) throw contradiction('finish takes paint or stain, not both.');
  const finish: CabinetFinish = p.finish?.stain !== undefined ? { stain: p.finish.stain } : { paint: p.finish?.paint ?? D.DEFAULT_PAINT };
  const back = p.back ?? true, drawerBoxes = p.drawerBoxes ?? true, finishedEnds = p.finishedEnds ?? 'none';
  const at: Vec3 = p.at ?? (type === 'wall' ? [0, 0, D.WALL_HANG_HEIGHT] : [0, 0, 0]);
  const used: CabinetUsed = { type, width, height, depth, at, frame, overlay, doorStyle, doors, drawers, drawerBoxes, sinkFront, shelves, toeKick, back, finish, finishedEnds };

  const t = D.STOCK, frameDepth = faceFrame ? t : 0, backT = back ? D.BACK : 0, floor = toeKick ? D.TOE_KICK_HEIGHT : 0;
  const b = new Builder();
  const interiorBack = depth - backT;

  // The box.
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
  const topUnder = height - t;
  if (type === 'base') {
    b.add('Front Stretcher', null, 'box', insideX, range(frameDepth, frameDepth + D.STRETCHER), range(topUnder, height), '+x', '+y');
    b.add('Rear Stretcher', null, 'box', insideX, range(interiorBack - D.STRETCHER, interiorBack), range(topUnder, height), '+x', '+y');
  } else {
    b.add('Top', null, 'box', insideX, insideY, range(topUnder, height), '+x', '+y');
  }
  if (back) b.add('Back', null, 'box', range(t - D.BACK_RABBET, width - t + D.BACK_RABBET), range(interiorBack, depth), range(floor, height), '+z', '+x');
  if (toeKick) b.add('Toe Kick', null, 'show', insideX, range(D.TOE_KICK_DEPTH, D.TOE_KICK_DEPTH + t), range(0, floor), '+x', '+z');

  // Rows of fronts, top to bottom. A frameless cabinet treats each front as its own opening with no overlay.
  const outerTop = faceFrame ? D.FRAME_WIDTH : type === 'base' ? D.GAP : D.REVEAL;
  const outerBottom = faceFrame ? D.FRAME_WIDTH : D.REVEAL;
  const divider = faceFrame ? D.FRAME_WIDTH : D.GAP;
  const overlayAt = (outer: boolean): number => !faceFrame ? 0 : overlay === 'inset' ? -D.GAP / 2 : overlay === 'partial' ? D.PARTIAL_OVERLAY : outer ? D.FULL_OVERLAY : (D.FRAME_WIDTH - D.GAP) / 2;

  const doorRows = doors > 0 ? 1 : 0, rowCount = drawers + doorRows;
  const rows: Row[] = [];
  if (rowCount > 0) {
    const available = height - floor - outerTop - outerBottom - divider * (rowCount - 1);
    const fixedDrawerOpening = (position: number): number => D.DRAWER_FRONT - overlayAt(position === 0) - overlayAt(position === rowCount - 1);
    const drawersFirst = type !== 'tall';
    const drawerPositions = Array.from({ length: drawers }, (_, i) => (drawersFirst ? i : i + doorRows));
    let openings: number[];
    if (doors > 0) {
      const drawerTotal = drawerPositions.reduce((sum, position) => sum + fixedDrawerOpening(position), 0);
      const doorOpening = available - drawerTotal;
      const doorIsTop = !drawersFirst;
      const doorFront = doorOpening + overlayAt(doorIsTop || rowCount === 1) + overlayAt(rowCount === 1 || drawersFirst);
      if (doorFront < D.MIN_DOOR_HEIGHT) throw unsound(`The drawers leave only ${inch(doorFront)} for doors in a ${inch(height)} cabinet. ${steer}`);
      openings = Array.from({ length: rowCount }, (_, i) => (drawerPositions.includes(i) ? fixedDrawerOpening(i) : doorOpening));
    } else if (drawers > 0) {
      const weights = GRADUATED[drawers]!, total = weights.reduce((a, c) => a + c, 0);
      openings = weights.map(w => (available * w) / total);
    } else {
      openings = [];
    }
    let top = height - outerTop;
    openings.forEach((opening, i) => {
      const bottom = top - opening;
      const front = range(bottom - overlayAt(i === rowCount - 1), top + overlayAt(i === 0));
      const isDrawer = drawerPositions.includes(i), drawerNumber = drawerPositions.indexOf(i) + 1;
      if (isDrawer && span(front) < D.MIN_DRAWER_HEIGHT) throw unsound(`A drawer front would be ${inch(span(front))} tall. ${steer}`);
      rows.push({
        kind: !isDrawer ? 'door' : sinkFront ? 'sink' : 'drawer',
        opening: range(bottom, top), front, index: drawerNumber,
        name: !isDrawer ? 'Door' : sinkFront ? 'False Front' : drawers === 1 ? 'Drawer' : `Drawer ${drawerNumber}`,
      });
      top = bottom - divider;
    });
  }

  // Face frame.
  if (faceFrame) {
    const A = 'Face Frame', fy = range(0, t), rail = range(D.FRAME_WIDTH, width - D.FRAME_WIDTH);
    b.add('Left Stile', A, 'show', range(0, D.FRAME_WIDTH), fy, range(floor, height), '+z', '+x');
    b.add('Right Stile', A, 'show', range(width - D.FRAME_WIDTH, width), fy, range(floor, height), '+z', '-x');
    b.add('Top Rail', A, 'show', rail, fy, range(height - D.FRAME_WIDTH, height), '+x', '-z');
    b.add('Bottom Rail', A, 'show', rail, fy, range(floor, floor + D.FRAME_WIDTH), '+x', '+z');
    rows.slice(1).forEach((row, i) => b.add(`Middle Rail ${i + 1}`, A, 'show', rail, fy, range(row.opening.to, row.opening.to + D.FRAME_WIDTH), '+x', '+z'));
    const doorRow = rows.find(r => r.kind === 'door');
    if (doorRow && doors === 2) b.add('Center Stile', A, 'show', range(width / 2 - D.FRAME_WIDTH / 2, width / 2 + D.FRAME_WIDTH / 2), fy, doorRow.opening, '+z', '+x');
  }

  // Fronts.
  const inset = overlay === 'inset';
  const frontY = inset ? 0 : -t;
  const fullOpening = faceFrame ? range(D.FRAME_WIDTH, width - D.FRAME_WIDTH) : range(D.REVEAL, width - D.REVEAL);
  const expand = (open: Range, outerLeft: boolean, outerRight: boolean): Range => range(open.from - overlayAt(outerLeft), open.to + overlayAt(outerRight));
  for (const row of rows) {
    if (row.kind === 'door') {
      const style: FrontStyle = doorStyle === 'none' ? 'slab' : doorStyle;
      const openings: { name: string; x: Range; outerLeft: boolean; outerRight: boolean }[] = doors === 1
        ? [{ name: 'Door', x: fullOpening, outerLeft: true, outerRight: true }]
        : faceFrame
          ? [{ name: 'Left Door', x: range(fullOpening.from, width / 2 - D.FRAME_WIDTH / 2), outerLeft: true, outerRight: false }, { name: 'Right Door', x: range(width / 2 + D.FRAME_WIDTH / 2, fullOpening.to), outerLeft: false, outerRight: true }]
          : [{ name: 'Left Door', x: range(fullOpening.from, width / 2 - D.GAP / 2), outerLeft: true, outerRight: false }, { name: 'Right Door', x: range(width / 2 + D.GAP / 2, fullOpening.to), outerLeft: false, outerRight: true }];
      for (const o of openings) {
        const x = expand(o.x, o.outerLeft, o.outerRight);
        checkFive(style, span(x), span(row.front), o.name);
        addFront(b, o.name, { x, z: row.front }, frontY, style, false, 'Slab');
      }
      continue;
    }
    const x = expand(fullOpening, true, true);
    if (row.kind === 'sink') {
      b.add('False Front', null, 'show', x, range(frontY, frontY + t), row.front, '+x', '+z');
      continue;
    }
    const tall = span(row.front) >= D.SLAB_DRAWER_BELOW - 1e-9;
    const wanted: FrontStyle = !tall || doorStyle === 'none' ? 'slab' : doorStyle;
    const raisedFits = span(x) - 2 * D.STILE >= minRaisedPanelOpening() && span(row.front) - 2 * D.STILE >= minRaisedPanelOpening();
    const style: FrontStyle = wanted === 'raised' && !raisedFits ? 'shaker' : wanted;
    checkFive(style, span(x), span(row.front), row.name);
    addFront(b, row.name, { x, z: row.front }, frontY, style, true, 'Front');

    if (!drawerBoxes) continue;
    const between = faceFrame ? fullOpening : insideX;
    const bx = range(between.from + D.DRAWER_SLIDES / 2, between.to - D.DRAWER_SLIDES / 2);
    const startY = inset ? t : 0, endY = interiorBack - D.DRAWER_CLEARANCE;
    const lowest = Math.max(row.opening.from + (faceFrame ? D.DRAWER_CLEARANCE / 2 : D.DRAWER_CLEARANCE), floor + t + D.DRAWER_CLEARANCE / 2);
    const highest = Math.min(row.opening.to - (faceFrame ? D.DRAWER_CLEARANCE / 2 : D.DRAWER_CLEARANCE), topUnder - D.DRAWER_CLEARANCE / 2);
    if (highest - lowest < D.MIN_DRAWER_HEIGHT || endY - startY < D.MIN_DRAWER_LENGTH) throw unsound(`${row.name} leaves no room for a drawer box. Set drawerBoxes to false, or ${steer.toLowerCase()}`);
    const bz = range(lowest, highest), by = range(startY, endY), s = D.DRAWER_SIDE, A = row.name;
    b.add('Box Left Side', A, 'box', range(bx.from, bx.from + s), by, bz, '+y', '+z');
    b.add('Box Right Side', A, 'box', range(bx.to - s, bx.to), by, bz, '+y', '+z');
    const betweenSides = range(bx.from + s, bx.to - s);
    b.add('Box Front', A, 'box', betweenSides, range(by.from, by.from + s), bz, '+x', '+z');
    b.add('Box Back', A, 'box', betweenSides, range(by.to - s, by.to), bz, '+x', '+z');
    const bottomZ = range(bz.from + D.DRAWER_BOTTOM_INSET, bz.from + D.DRAWER_BOTTOM_INSET + D.DRAWER_BOTTOM);
    b.add('Box Bottom', A, 'box', betweenSides, range(by.from + s, by.to - s), bottomZ, '+x', '+y');
  }

  // Shelves share the door section.
  if (shelves > 0) {
    const doorRow = rows.find(r => r.kind === 'door');
    const region = doorRow ? range(Math.max(doorRow.opening.from, floor + t), Math.min(doorRow.opening.to, topUnder)) : range(floor + t, topUnder);
    const free = span(region) - shelves * t, spacing = free / (shelves + 1);
    if (spacing < D.MIN_SHELF_SPACE) throw unsound(`${shelves} shelves do not fit in ${inch(span(region))} of height. Use fewer shelves, or ${steer.toLowerCase()}`);
    const sx = range(t + D.SHELF_SIDE_CLEARANCE, width - t - D.SHELF_SIDE_CLEARANCE);
    const sy = range(frameDepth + D.SHELF_SETBACK, interiorBack - D.SHELF_BACK_CLEARANCE);
    for (let i = 0; i < shelves; i++) {
      const bottom = region.from + spacing * (i + 1) + t * i;
      b.add(shelves === 1 ? 'Shelf' : `Shelf ${i + 1}`, null, 'box', sx, sy, range(bottom, bottom + t), '+x', '+y');
    }
  }

  const typeName = type === 'base' ? 'Base' : type === 'wall' ? 'Wall' : 'Tall';
  return { name: p.name ?? `${typeName} Cabinet ${inch(width)}`, at, used, parts: b.parts };
}
