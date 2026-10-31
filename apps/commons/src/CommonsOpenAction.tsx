// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { commonsOpenUrl, isCommonsOpenable, type CatalogModel } from '@pushform/cloud';
export function CommonsOpenAction({ model, editorUrl = 'https://app.pushform.io' }: { model: CatalogModel; editorUrl?: string | undefined }) {
  const files = model.files.filter(file => isCommonsOpenable(file.name));
  if (!files.length) return <p className="open-hint">Download the original files below. A supported model file or conversion is needed to open this model in PushForm.</p>;
  const preferred = files.find(file => /\.pf$/i.test(file.name)) ?? files.find(file => /\.(step|stp|glb)$/i.test(file.name)) ?? files[0]!;
  const url = commonsOpenUrl(editorUrl, model, preferred.id);
  return url ? <div className="open-in-pushform"><a className="open-model" href={url} target="_blank" rel="noreferrer">Open in PushForm ↗</a>
    <p>Opens {preferred.name} as a new model. Sign-in is required. Your current project stays open.</p></div> : <p>Opening in PushForm is unavailable in this build.</p>;
}
