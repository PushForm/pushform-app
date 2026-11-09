// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { LENGTH_TOL } from '@pushform/core';
import type { Vec3 } from '@pushform/core';
import { Builder, BuilderPlanError, range } from '../builders/parts';
import type { BuilderPlan, MaterialSpec } from '../builders/parts';
import * as D from '../cabinet/dimensions';
import { planCabinet } from '../cabinet/plan';
import type { CabinetFrame, CabinetOverlay, CabinetParams, CabinetSide } from '../cabinet/plan';
import { planCountertop } from '../countertop/plan';

const inches = D.inches;
const COUNTER_FRONT = inches(1.75);
const DEFAULT_FILLER = inches(3);
const DEFAULT_CORNER = { base: { blind: inches(42), other: inches(36) }, wall: { blind: inches(30), other: inches(24) } } as const;

type CabinetOptions = Pick<CabinetParams, 'doors' | 'drawers' | 'drawerBoxes' | 'drawerFronts' | 'sinkFront' | 'shelves' | 'doorStyle' | 'glass' | 'stackedDoors' | 'upperDoorHeight' | 'upperDoorStyle' | 'finishedInterior'>;
export interface KitchenRunItem extends CabinetOptions {
  readonly width: number;
  /** An opening for an appliance instead of a cabinet. A dishwasher keeps the counter going; a range or refrigerator breaks it. */
  readonly appliance?: 'dishwasher' | 'range' | 'refrigerator' | undefined;
  readonly name?: string | undefined;
}
export interface KitchenRunParams {
  readonly at?: Vec3 | undefined;
  readonly base: readonly KitchenRunItem[];
  readonly wall?: readonly KitchenRunItem[] | undefined;
  readonly corner?: {
    readonly style: 'blind' | 'diagonal' | 'l_shaped';
    readonly side?: CabinetSide | undefined;
    readonly width?: number | undefined;
    readonly wallWidth?: number | undefined;
    readonly filler?: number | undefined;
    readonly lazySusan?: boolean | undefined;
    readonly returnBase: readonly KitchenRunItem[];
    readonly returnWall?: readonly KitchenRunItem[] | undefined;
  } | undefined;
  readonly frame?: CabinetFrame | undefined;
  readonly overlay?: CabinetOverlay | undefined;
  readonly doorStyle?: CabinetParams['doorStyle'];
  readonly finish?: CabinetParams['finish'];
  readonly wallHeight?: number | undefined;
  readonly boxFinish?: CabinetParams['boxFinish'];
  readonly beadedFrame?: boolean | undefined;
  readonly hardware?: CabinetParams['hardware'];
  readonly hardwareFinish?: string | undefined;
  readonly hardwarePlacement?: CabinetParams['hardwarePlacement'];
  readonly countertop?: boolean | undefined;
  readonly countertopFinish?: { readonly paint?: string | undefined; readonly library?: string | undefined } | undefined;
  readonly backsplash?: number | undefined;
  readonly name?: string | undefined;
}

const countersThrough = (item: KitchenRunItem): boolean => item.appliance !== 'range' && item.appliance !== 'refrigerator';
const total = (items: readonly KitchenRunItem[]): number => items.reduce((sum, item) => sum + item.width, 0);

interface Row { readonly type: 'base' | 'wall'; readonly depth: number; readonly z: number; readonly height?: number | undefined }

export function planKitchenRun(p: KitchenRunParams): BuilderPlan {
  if (p.base.length === 0) throw new BuilderPlanError('invalid_operation', 'base needs at least one item.');
  const corner = p.corner, side = corner?.side ?? 'left', flipped = side === 'right';
  if (corner) {
    const besideCorner = [flipped ? p.base[p.base.length - 1] : p.base[0], corner.returnBase[0]];
    for (const item of besideCorner) {
      if (item?.appliance) {
        throw new BuilderPlanError('invalid_geometry', 'Place a base cabinet at least 9 in wide between an appliance opening and the inside corner, on each run. A corner cabinet or filler alone does not provide this buffer.');
      }
    }
  }
  const shared: Pick<CabinetParams, 'frame' | 'overlay' | 'doorStyle' | 'finish' | 'boxFinish' | 'beadedFrame' | 'hardware' | 'hardwareFinish' | 'hardwarePlacement'> = {
    ...(p.frame ? { frame: p.frame } : {}), ...(p.overlay ? { overlay: p.overlay } : {}), ...(p.doorStyle ? { doorStyle: p.doorStyle } : {}), ...(p.finish ? { finish: p.finish } : {}),
    ...(p.boxFinish ? { boxFinish: p.boxFinish } : {}), ...(p.beadedFrame !== undefined ? { beadedFrame: p.beadedFrame } : {}), ...(p.hardware ? { hardware: p.hardware } : {}), ...(p.hardwareFinish ? { hardwareFinish: p.hardwareFinish } : {}), ...(p.hardwarePlacement ? { hardwarePlacement: p.hardwarePlacement } : {}),
  };
  const baseRow: Row = { type: 'base', depth: D.DEFAULT_DEPTH.base, z: 0 };
  const wallRow: Row = { type: 'wall', depth: D.DEFAULT_DEPTH.wall, z: D.WALL_HANG_HEIGHT, height: p.wallHeight };
  const back = baseRow.depth;
  const filler = corner?.filler ?? DEFAULT_FILLER;
  const blind = corner?.style === 'blind';
  const cornerWidth = (row: Row): number => (row.type === 'base' ? corner?.width : corner?.wallWidth) ?? DEFAULT_CORNER[row.type][blind ? 'blind' : 'other'];
  const baseCorner = corner ? cornerWidth(baseRow) : 0;
  const overall = total(p.base) + baseCorner;
  const b = new Builder();
  const children: BuilderPlan[] = [];
  const roleLabel = (item: KitchenRunItem, row: Row): string | null => {
    if (row.type !== 'base') return null;
    if (item.sinkFront) return 'Sink Base';
    return (item.doors === 0 && (item.drawers ?? 3) > 0) ? 'Drawer Base' : null;
  };
  const cabinet = (row: Row, item: KitchenRunItem, at: Vec3, label: string, ends: 'none' | 'left' | 'right' | 'both', rotationDeg?: number): void => {
    if (item.appliance) return;
    const { width, appliance: _appliance, name, ...options } = item;
    const role = roleLabel(item, row);
    const plan = planCabinet({ ...shared, ...options, type: row.type, width, at, finishedEnds: ends, name: name ?? (role ? `${role} ${Math.round(width / 0.0254)} in` : label), ...(row.height ? { height: row.height } : {}) });
    children.push(rotationDeg ? { ...plan, rotationDeg } : plan);
  };

  /** One straight row with its corner. Returns where the return leg starts, as y decreases away from the corner. */
  const placeRow = (row: Row, items: readonly KitchenRunItem[], label: string): number | null => {
    const frontY = back - row.depth;
    const widthHere = corner ? cornerWidth(row) : 0;
    let legStart: number | null = null;
    if (corner) {
      const atX = flipped ? overall - widthHere : 0;
      if (blind) {
        const blindWidth = widthHere - D.DEFAULT_BLIND_DOOR;
        if (blindWidth < row.depth + D.STOCK - LENGTH_TOL) throw new BuilderPlanError('invalid_geometry', `A ${Math.round(widthHere / 0.0254)} in blind corner leaves too little room for the cabinets returning into it; widen it.`);
        children.push(planCabinet({ ...shared, type: row.type, width: widthHere, at: [atX, frontY, row.z], name: `${label} Corner`, finishedEnds: 'none', corner: { style: 'blind', side, blindWidth }, ...(row.height ? { height: row.height } : {}) }));
        legStart = frontY - D.STOCK - filler;
      } else {
        children.push(planCabinet({ ...shared, type: row.type, width: widthHere, depth: row.depth, at: [atX, back - widthHere, row.z], name: `${label} Corner`, finishedEnds: 'none', corner: { style: corner.style, side, returnWidth: widthHere, lazySusan: row.type === 'base' ? corner.lazySusan ?? false : false }, ...(row.height ? { height: row.height } : {}) }));
        legStart = back - widthHere;
      }
    }
    let x = flipped || !corner ? (flipped && corner ? overall - widthHere - total(items) : 0) : widthHere;
    const endsOf = (i: number): 'none' | 'left' | 'right' | 'both' => {
      const left = i === 0 && (!corner || flipped), right = i === items.length - 1 && (!corner || !flipped);
      return left && right ? 'both' : left ? 'left' : right ? 'right' : 'none';
    };
    items.forEach((item, i) => { cabinet(row, item, [x, frontY, row.z], item.name ?? `${label} ${i + 1}`, endsOf(i)); x += item.width; });
    return legStart;
  };

  /** A row returning along the corner's side wall, turned to face into the room. */
  const placeReturn = (row: Row, items: readonly KitchenRunItem[], start: number, label: string): void => {
    let y = start;
    items.forEach((item, i) => {
      const at: Vec3 = flipped ? [overall - row.depth, y, row.z] : [row.depth, y - item.width, row.z];
      cabinet(row, item, at, item.name ?? `${label} ${i + 1}`, i === items.length - 1 ? (flipped ? 'right' : 'left') : 'none', flipped ? -90 : 90);
      y -= item.width;
    });
    if (blind) {
      const height = row.height ?? (row.type === 'base' ? D.DEFAULT_HEIGHT.base : D.DEFAULT_HEIGHT.wall);
      const bottom = row.z + (row.type === 'base' ? D.TOE_KICK_HEIGHT : 0);
      const fx = flipped ? range(overall - row.depth - D.STOCK, overall - row.depth) : range(row.depth, row.depth + D.STOCK);
      b.add(`${label} Filler`, null, 'show', fx, range(start, start + filler), range(bottom, row.z + height), '+z', flipped ? '-y' : '+y');
    }
  };

  const legStart = placeRow(baseRow, p.base, 'Base');
  if (corner) placeReturn(baseRow, corner.returnBase, legStart!, 'Return Base');
  if (p.wall?.length) {
    const wallStart = placeRow(wallRow, p.wall, 'Wall');
    if (corner?.returnWall?.length) placeReturn(wallRow, corner.returnWall, wallStart!, 'Return Wall');
  }

  if (p.countertop ?? true) {
    const z = D.DEFAULT_HEIGHT.base, counterDepth = back + COUNTER_FRONT, frontY = -COUNTER_FRONT;
    const counter = { ...(p.countertopFinish ? { finish: p.countertopFinish } : {}), ...(p.backsplash !== undefined ? { backsplash: p.backsplash } : {}) };
    // Spans of the main wall, left to right, broken at a range or refrigerator.
    interface Span { from: number; to: number; cutouts: { x: number; width: number }[] }
    // Over a diagonal corner the top's front runs parallel to the angled doors with the same overhang as along the walls.
    const diagonalChamfer = baseCorner + COUNTER_FRONT * (Math.SQRT2 - 1) - counterDepth;
    const spans: Span[] = [];
    let open: Span | null = corner && !flipped ? { from: 0, to: baseCorner, cutouts: [] } : null;
    let x = corner && !flipped ? baseCorner : 0;
    const sinkOpening = inches(6);
    for (const item of p.base) {
      if (countersThrough(item)) {
        open ??= { from: x, to: x, cutouts: [] };
        open.to = x + item.width;
        if (item.sinkFront) open.cutouts.push({ x: x + sinkOpening / 2, width: item.width - sinkOpening });
      } else if (open) { spans.push(open); open = null; }
      x += item.width;
    }
    if (corner && flipped) { open ??= { from: x, to: x, cutouts: [] }; open.to = overall; }
    if (open) spans.push(open);

    // The leg carries the return run up to its first break; anything past that is its own straight top.
    const leg = corner?.returnBase ?? [];
    const firstBreak = leg.findIndex(item => !countersThrough(item));
    const through = firstBreak < 0 ? leg : leg.slice(0, firstBreak);
    if (corner && leg.some(item => item.sinkFront)) throw new BuilderPlanError('invalid_operation', 'Put the sink on the main wall; a countertop leg takes no cutout.');
    const legEnd = (legStart ?? 0) - total(through);
    const legLength = corner ? Math.max(0, frontY - legEnd) : 0;
    const cornerSpan = corner ? (flipped ? spans[spans.length - 1] : spans[0]) : undefined;
    spans.forEach((span, i) => {
      const onCorner = span === cornerSpan && legLength > 0;
      children.push(planCountertop({
        width: span.to - span.from, depth: counterDepth, ...counter, name: spans.length > 1 ? `Countertop ${i + 1}` : 'Countertop',
        at: [span.from, frontY - (onCorner ? legLength : 0), z],
        cutouts: span.cutouts.map(c => ({ x: c.x - span.from, width: c.width })),
        ...(onCorner ? { leg: { side, length: legLength, depth: counterDepth, ...(corner?.style === 'diagonal' ? { chamfer: diagonalChamfer } : {}) } } : {}),
      }));
    });
    if (corner && firstBreak >= 0) {
      let y = legEnd - leg[firstBreak]!.width, run = 0, part = 1;
      const flush = (): void => {
        if (run === 0) return;
        const low = y + 0, at: Vec3 = flipped ? [overall - counterDepth, low + run, z] : [counterDepth, low, z];
        const plan = planCountertop({ width: run, depth: counterDepth, ...counter, name: `Return Countertop ${part++}`, at });
        children.push({ ...plan, rotationDeg: flipped ? -90 : 90 });
        run = 0;
      };
      for (const item of leg.slice(firstBreak + 1)) {
        if (countersThrough(item)) { y -= item.width; run += item.width; } else { flush(); y -= item.width; }
      }
      flush();
    }
  }

  const finish = p.finish;
  const show: MaterialSpec = finish?.stain !== undefined ? { library: finish.stain } : { paint: finish?.paint ?? D.DEFAULT_PAINT };
  return {
    name: p.name ?? 'Kitchen Run', at: p.at ?? [0, 0, 0], parts: b.parts, children, materials: { show },
    used: { overallWidth: overall, cabinets: children.length, baseCornerWidth: baseCorner, side: corner ? side : null, cornerStyle: corner?.style ?? null, countertop: p.countertop ?? true },
  };
}
