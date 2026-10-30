// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { ComponentType } from 'react';
import type { PanelId } from '../store';
import { EntityInfoPanel } from './EntityInfoPanel';
import { MaterialsPanel } from './MaterialsPanel';
import { ComponentsPanel } from './ComponentsPanel';
import { StylesPanel } from './StylesPanel';
import { TagsPanel } from './TagsPanel';
import { ScenesPanel } from './ScenesPanel';
import { ShadowsPanel } from './ShadowsPanel';
import { DisplayPanel } from './DisplayPanel';
import { ModelInfoPanel } from './ModelInfoPanel';
import { SoftenEdgesPanel } from './SoftenEdgesPanel';
import { InstructorPanel } from './InstructorPanel';
import { LastOperationPanel } from './LastOperationPanel';
import { FogPanel } from './FogPanel';

export interface PanelSpec {
  readonly id: PanelId;
  readonly title: string;
  readonly component: ComponentType;
}

export const PANELS: readonly PanelSpec[] = [
  { id: 'entityInfo', title: 'Entity Info', component: EntityInfoPanel },
  { id: 'materials', title: 'Materials', component: MaterialsPanel },
  { id: 'components', title: 'Components', component: ComponentsPanel },
  { id: 'styles', title: 'Styles', component: StylesPanel },
  { id: 'tags', title: 'Tags', component: TagsPanel },
  { id: 'scenes', title: 'Scenes', component: ScenesPanel },
  { id: 'shadows', title: 'Shadows', component: ShadowsPanel },
  { id: 'display', title: 'Display', component: DisplayPanel },
  { id: 'modelInfo', title: 'Model Info', component: ModelInfoPanel },
  { id: 'softenEdges', title: 'Soften Edges', component: SoftenEdgesPanel },
  { id: 'instructor', title: 'Instructor', component: InstructorPanel },
  { id: 'lastOperation', title: 'Last Operation', component: LastOperationPanel },
  { id: 'fog', title: 'Fog', component: FogPanel },
];
