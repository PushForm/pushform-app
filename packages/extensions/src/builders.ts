// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { planCountertop, planKitchenRun, type BuilderPlan } from '@pushform/commands';
import type { ModelBuilderKey, ModelBuilderParams } from '@pushform/extension-protocol';

/** The planner behind each builder. A builder missing here is a compile error. */
export const BUILDER_PLANNERS: { readonly [K in ModelBuilderKey]: (params: ModelBuilderParams<K>) => BuilderPlan } = {
  countertop: planCountertop,
  kitchen_run: planKitchenRun,
};

export const planBuilder = <K extends ModelBuilderKey>(key: K, params: ModelBuilderParams<K>): BuilderPlan => BUILDER_PLANNERS[key](params);
