// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { layoutPathContours, pathSegment, type LayoutRectanglePath, type LayoutEntity } from '@pushform/layout';
import type { useLayoutShapeBuilder } from './useLayoutShapeBuilder';

function pathData(shape: LayoutRectanglePath): string {
  return layoutPathContours(shape.points, shape.handles, shape.closed, shape.contourStarts).map(contour => {
    let d = `M${contour.points[0]!.join(',')}`;
    for (let i = 0; i < contour.points.length; i++) {
      const segment = pathSegment(contour.points, contour.handles, i, true);
      d += segment.curved ? `C${segment.c1.join(',')} ${segment.c2.join(',')} ${segment.b.join(',')}` : `L${segment.b.join(',')}`;
    }
    return `${d}Z`;
  }).join(' ');
}

export function LayoutShapeBuilderPreview({ builder, size, defaultStyle }: {
  builder: ReturnType<typeof useLayoutShapeBuilder>; size: [number, number]; defaultStyle: NonNullable<LayoutEntity['style']>;
}) {
  const { session, result } = builder;
  if (!session || session.busy || !result) return null;
  const color = builder.effectiveMode === 'add' ? '#1e63d1' : '#d62975';
  return (
    <svg className="pf-layout-shape-builder-preview" aria-label="Shape Builder preview" viewBox={`0 0 ${size[0]} ${size[1]}`}>
      <rect width={size[0]} height={size[1]} fill="white" fillOpacity={0.82} />
      {session.regions.map(region => <path key={region.key} d={pathData(region.shape)} fillRule="evenodd"
        fill={result.removed.includes(region.key) ? '#d629751c' : '#ffffff80'} stroke="#697386" strokeWidth={1} vectorEffect="non-scaling-stroke" />)}
      {result.groups.map((group, i) => {
        const style = session.sources[group.sourceIndex]?.style ?? defaultStyle;
        return <path key={i} data-result="true" d={pathData(group.shape)} fillRule="evenodd"
        fill={style.fillColor ?? 'none'} stroke={style.strokeColor ?? defaultStyle.strokeColor}
        strokeWidth={(style.strokeWeightPt ?? defaultStyle.strokeWeightPt ?? 0.5) * 25.4 / 72}
        strokeDasharray={style.strokeDashMm?.join(' ')} />;
      })}
      {session.regions.filter(region => result.selected.includes(region.key)).map(region =>
        <path key={`selected-${region.key}`} data-selected-region="true" d={pathData(region.shape)} fillRule="evenodd"
          fill="#1e63d1" fillOpacity={0.22} stroke="#1e63d1" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />)}
      {session.regions.filter(region => builder.hover.includes(region.key)).map(region =>
        <path key={region.key} d={pathData(region.shape)} fillRule="evenodd" fill={color} fillOpacity={0.22}
          stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />)}
    </svg>
  );
}
