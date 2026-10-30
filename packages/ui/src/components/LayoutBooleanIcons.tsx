// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { IconBaseProps, IconType } from 'react-icons';

// Original diagrams on Tabler's 24-unit grid. Solid outlines show the result;
// dashed red guides show the cutter, following the visual convention in Inkscape.
const target = 'M6 8h10v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z';
const cutter = 'M10 4h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8V6a2 2 0 0 1 2-2Z';
const difference = 'M6 8h2v8h8v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z';

function diagram(
  operation: 'difference' | 'intersection' | 'exclusion' | 'division' | 'cut-path',
): IconType {
  return function BooleanDiagram({ size = 18, title, ...props }: IconBaseProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
        {...props}
      >
        {title ? <title>{title}</title> : null}
        {operation === 'exclusion' ? (
          <>
            <path
              d={`${target} ${cutter}`}
              fill="currentColor"
              fillOpacity={0.18}
              fillRule="evenodd"
              stroke="none"
            />
            <path d={`${target} ${cutter}`} />
          </>
        ) : (
          <>
            <path d={cutter} stroke="#d65353" strokeWidth={1.3} strokeDasharray="1.5 2.2" />
            {operation === 'intersection' ? (
              <>
                <path d={target} stroke="#d65353" strokeWidth={1.3} strokeDasharray="1.5 2.2" />
                <path d="M8 8h8v8H8Z" fill="currentColor" fillOpacity={0.18} />
              </>
            ) : operation === 'difference' ? (
              <path d={difference} fill="currentColor" fillOpacity={0.18} />
            ) : operation === 'division' ? (
              <>
                <path d={difference} fill="currentColor" fillOpacity={0.18} />
                <path d="M9.5 6.5h8v8h-8Z" fill="currentColor" fillOpacity={0.18} />
              </>
            ) : (
              <>
                <path d="M6.5 8H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-.5M9.5 8H16v6.5" />
                <path d="M6.5 7v2M9.5 7v2M15 14.5h2M15 17.5h2" strokeWidth={1.1} />
              </>
            )}
          </>
        )}
      </svg>
    );
  };
}

export const LayoutDifferenceIcon = diagram('difference');
export const LayoutIntersectionIcon = diagram('intersection');
export const LayoutExclusionIcon = diagram('exclusion');
export const LayoutDivisionIcon = diagram('division');
export const LayoutCutPathIcon = diagram('cut-path');
