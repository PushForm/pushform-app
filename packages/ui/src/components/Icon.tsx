// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { MdUpdate } from 'react-icons/md';
import { AiOutlineTable } from 'react-icons/ai';
import { BsCloudFog2 } from 'react-icons/bs';
import type { JSX } from 'react';
import type { IconType } from 'react-icons';
import { LuPuzzle } from 'react-icons/lu';
import { PiAngle, PiBezierCurve, PiTreeView } from 'react-icons/pi';
import { RiChatDeleteLine, RiChatAiLine } from 'react-icons/ri';
import { TbLayersUnion, TbOval, TbPackageImport, TbTextSize, TbWriting } from 'react-icons/tb';
import { LayoutDifferenceIcon, LayoutIntersectionIcon, LayoutExclusionIcon, LayoutDivisionIcon, LayoutCutPathIcon } from './LayoutBooleanIcons';
import { LayoutFilletIcon } from './LayoutFilletIcon';
import { LayoutShapeBuilderIcon } from './LayoutShapeBuilderIcon';
import {
  LuSave,
  LuArrowDown,
  LuBold,
  LuItalic,
  LuUnderline,
  LuAlignLeft,
  LuAlignCenter,
  LuAlignRight,
  LuArrowUp,
  LuBlend,
  LuBox,
  LuBoxes,
  LuCombine,
  LuDiamond,
  LuDraftingCompass,
  LuImage,
  LuPlus,
  LuPrinter,
  LuMinus,
  LuGripVertical,
  LuRoute,
  LuScissors,
  LuShapes,
  LuSplit,
  LuSquareMinus,
  LuTag,
  LuChevronDown,
  LuComponent,
  LuEllipsisVertical,
  LuEye,
  LuEyeOff,
  LuLock,
  LuLockOpen,
  LuChevronRight,
  LuCircle,
  LuClapperboard,
  LuCopy,
  LuEraser,
  LuFilePlus2,
  LuFile,
  LuFileText,
  LuHand,
  LuHexagon,
  LuLassoSelect,
  LuInfo,
  LuMonitor,
  LuPresentation,
  LuMousePointer2,
  LuMove,
  LuOrbit,
  LuPaintBucket,
  LuPalette,
  LuPencil,
  LuRectangleHorizontal,
  LuRotateCw,
  LuRuler,
  LuScaling,
  LuSlash,
  LuSun,
  LuSwatchBook,
  LuTags,
  LuTrash2,
  LuType,
  LuZoomIn,
} from 'react-icons/lu';

/** Filled glyph: the shared stroke width would thicken it, so it draws with fill only. */
const FogIcon: IconType = (props) => <BsCloudFog2 {...props} strokeWidth={0} />;

/** Shared outline icons for the tool and panel strips. */
const REACT_ICONS: Record<string, IconType> = {
  'tool-shape-builder': LayoutShapeBuilderIcon,
  'tool-fillet': LayoutFilletIcon,
  save: LuSave,
  'check-updates': MdUpdate,
  'save-as': LuCopy,
  presentation: LuPresentation,
  image: LuImage,
  'text-bold': LuBold,
  'text-italic': LuItalic,
  'text-underline': LuUnderline,
  'text-align-left': LuAlignLeft,
  'text-align-center': LuAlignCenter,
  'text-align-right': LuAlignRight,
  grip: LuGripVertical,
  'tool-angular-dimension': PiAngle,
  'tool-dimension': LuRuler,
  'tool-text': LuType,
  'tool-text3d': TbTextSize,
  'tool-label': LuTags,
  'tool-table': AiOutlineTable,
  /** Clear Chat. */
  'chat-ai': RiChatAiLine,
  'object-browser': PiTreeView,
  extensions: LuPuzzle,
  'chat-delete': RiChatDeleteLine,
  'tool-viewport': TbPackageImport,
  'tool-select': LuMousePointer2,
  'tool-lasso': LuLassoSelect,
  'tool-eraser': LuEraser,
  'tool-paint': LuPaintBucket,
  'tool-line': LuSlash,
  'tool-rectangle': LuRectangleHorizontal,
  'tool-circle': LuCircle,
  'tool-ellipse': TbOval,
  'tool-polygon': LuHexagon,
  'tool-bezier': PiBezierCurve,
  'tool-freehand': TbWriting,
  'tool-move': LuMove,
  'tool-rotate': LuRotateCw,
  'tool-scale': LuScaling,
  'tool-boolean-union': TbLayersUnion,
  'tool-boolean-subtract': LayoutDifferenceIcon,
  'tool-boolean-intersect': LayoutIntersectionIcon,
  'tool-boolean-exclude': LayoutExclusionIcon,
  'tool-boolean-division': LayoutDivisionIcon,
  'tool-boolean-cut-path': LayoutCutPathIcon,
  'tool-tape': LuRuler,
  'tool-rotrect': LuDiamond,
  'tool-followme': LuRoute,
  'tool-protractor': LuDraftingCompass,
  'tool-tag': LuTag,
  'tool-texturePosition': LuImage,
  'tool-solid.outerShell': LuShapes,
  'tool-solid.union': LuCombine,
  'tool-solid.subtract': LuSquareMinus,
  'tool-solid.trim': LuScissors,
  'tool-solid.intersect': LuBlend,
  'tool-solid.split': LuSplit,
  'tool-orbit': LuOrbit,
  'tool-pan': LuHand,
  'tool-zoom': LuZoomIn,
  'panel-entityInfo': LuInfo,
  'panel-materials': LuSwatchBook,
  'panel-components': LuBoxes,
  'panel-styles': LuPalette,
  'panel-tags': LuTags,
  'panel-scenes': LuClapperboard,
  'panel-shadows': LuSun,
  'panel-fog': FogIcon,
  'panel-display': LuMonitor,
  'panel-modelInfo': LuFileText,
  'page-add': LuFilePlus2,
  'layer-page': LuFile,
  plus: LuPlus,
  print: LuPrinter,
  minus: LuMinus,
  'page-duplicate': LuCopy,
  'page-delete': LuTrash2,
  'page-rename': LuPencil,
  pencil: LuPencil,
  'page-up': LuArrowUp,
  'page-down': LuArrowDown,
  'chevron-right': LuChevronRight,
  'chevron-down': LuChevronDown,
  'outliner-group': LuBox,
  'outliner-component': LuComponent,
  eye: LuEye,
  'eye-off': LuEyeOff,
  lock: LuLock,
  unlock: LuLockOpen,
  more: LuEllipsisVertical,
};

/** Custom modeling glyphs and shell icons; unknown names fall back to initials. */
const PATHS: Record<string, string> = {
  'tool-circumscribed-polygon': 'M12 2l8.66 5v10L12 22l-8.66-5V7zM18 12a6 6 0 1 0-12 0 6 6 0 1 0 12 0',
  account: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 8 0 0 1 16 0v2',
  'folder': 'M3 6h6l2 2h10v12H3zM3 6V4h6l2 2h8v2',
  'document-layout': 'M4 3h16v18H4zM7 7h10M7 11h10M7 15h5',
  'document-template': 'M4 3h16v18H4zM7 7h10v5H7zM7 16h4M14 16h3M14 19h3',
  'document-model': 'M12 2 21 7v10l-9 5-9-5V7zM12 12l9-5M12 12L3 7M12 12v10',
  /** `assets/push-pull.svg` refit to the 24-unit grid: a face pulled out of a box; the Push/Pull tool. */
  'tool-pushpull':
    'M7.37 2.8H6.28L2 7.08V21.2H3.85M6.25 7.34L10.68 2.8H17.17V16.05L12.64 21.2H6.25ZM6.25 7.34H12.64V21.2M12.64 7.34L17.17 2.8M15.65 12.2H22M20.29 10.46L22 12.2L20.29 13.94',
  'tool-arc2': 'M4 18A14 14 0 0 1 20 18M4 18h.01M20 18h.01',
  'tool-arc3': 'M4 18A14 14 0 0 1 20 18M4 18h.01M20 18h.01M12 9.5h.01',
  'tool-arc': 'M6 18h.01M6 18V5M6 18h13M6 5a13 13 0 0 1 13 13',
  'tool-pie': 'M12 12V4a8 8 0 0 1 6.9 12L12 12z',
  'tool-rounded-rectangle':
    'M7 4h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z',
  'tool-bulged-rectangle': 'M6 4h12Q23 12 18 20H6Q1 12 6 4Z',
  'tool-lozenge': 'M9 5h6a7 7 0 0 1 0 14H9A7 7 0 0 1 9 5Z',
  'tool-axes': 'M12 20V4M12 20l-8 -4M12 20l8 -4M12 4l-2 2M12 4l2 2',
  'tool-chamfer': 'M4 20V12l8-8h8M4 4v3M8 4H4',
  'tool-offset': 'M4 4h16v16H4zM8 8h8v8H8z',
  'tool-zoomWindow': 'M4 4h5M4 4v5M20 4h-5M20 4v5M4 20h5M4 20v-5M20 20h-5M20 20v-5M10 10h4v4h-4z',
  'zoom-extents': 'M4 4h5M4 4v5M20 4h-5M20 4v5M4 20h5M4 20v-5M20 20h-5M20 20v-5M8 8h8v8H8z',
  'view-previous': 'M15 6l-6 6 6 6',
  'view-next': 'M9 6l6 6-6 6',
  undo: 'M9 7L4 12l5 5M4 12h11a5 5 0 0 1 0 10h-3',
  redo: 'M15 7l5 5-5 5M20 12H9a5 5 0 0 0 0 10h3',
  menu: 'M4 6h16M4 12h16M4 18h16',
  search: 'M10 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12M14.5 14.5L20 20',
  help: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01',
  close: 'M6 6l12 12M18 6L6 18',
  command: 'M5 7l5 5-5 5M12 17h7',
  'panel-softenEdges': 'M4 20V9a5 5 0 0 1 5-5h11M4 20h11a5 5 0 0 0 5-5V4M9 15a2 2 0 0 1 2-2h4',
  'panel-instructor': 'M3 9l9-4 9 4-9 4-9-4zM7 11v4c0 1.5 2.5 3 5 3s5-1.5 5-3v-4M21 9v6',
  'panel-lastOperation': 'M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4M12 8v4l3 2',
};

export function Icon({
  name,
  size = 18,
  title,
}: {
  name: string;
  size?: number;
  title?: string;
}): JSX.Element {
  const ReactIcon = REACT_ICONS[name];
  if (ReactIcon) {
    return <ReactIcon size={size} title={title ?? ''} strokeWidth={1.7} aria-hidden="true" />;
  }

  const d = PATHS[name];
  if (!d) {
    const initials = name
      .replace(/^(tool|panel)-/, '')
      .slice(0, 2)
      .toUpperCase();
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
        {title ? <title>{title}</title> : null}
        <text
          x="12"
          y="16"
          textAnchor="middle"
          fontSize="11"
          fontFamily="system-ui"
          fill="currentColor"
        >
          {initials}
        </text>
      </svg>
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {title ? <title>{title}</title> : null}
      <path d={d} />
    </svg>
  );
}
