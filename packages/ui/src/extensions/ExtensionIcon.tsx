// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useMemo, useSyncExternalStore, type JSX } from 'react';
import { isHostIcon } from '@pushform/extension-protocol';
import type { ExtensionPlatform } from '@pushform/extensions';
import { Icon } from '../components/Icon';
import { UI_ICON_NAMES } from './ExtensionUi';

/**
 * An icon an extension declared in its manifest: one of the host's own icons by name, or a PNG from the package,
 * served from the stored bytes through an object URL. Without one, the host's generic extension icon. An image
 * shown for its own sake (the activity bar) names the extension in `alt`; one beside a title is decorative.
 */
export function ExtensionIcon({ platform, extensionId, icon, size, alt = '' }: {
  readonly platform: ExtensionPlatform;
  readonly extensionId: string;
  readonly icon: string | null | undefined;
  readonly size: number;
  readonly alt?: string;
}): JSX.Element {
  const url = useIconUrl(platform, extensionId, icon && !isHostIcon(icon) ? icon : null);
  if (icon && isHostIcon(icon)) return <span className="pf-xicon" style={{ width: size, height: size }} aria-hidden={alt ? undefined : true} role={alt ? 'img' : undefined} aria-label={alt || undefined}><Icon name={UI_ICON_NAMES[icon]} size={size} /></span>;
  if (url) return <img className="pf-xicon" src={url} width={size} height={size} alt={alt} draggable={false} />;
  return <span className="pf-xicon" style={{ width: size, height: size }} aria-hidden={alt ? undefined : true} role={alt ? 'img' : undefined} aria-label={alt || undefined}><Icon name="extensions" size={size} /></span>;
}

/** Object URLs by the icon's bytes, which every copy of a record shares; a reinstalled package gets new ones. */
const urls = new WeakMap<Uint8Array, string>();

function useIconUrl(platform: ExtensionPlatform, extensionId: string, path: string | null): string | null {
  // The revision says when what is installed changed, and with it the bytes.
  const revision = useSyncExternalStore((notify) => platform.subscribe(notify), () => platform.revision);
  return useMemo(() => {
    if (!path) return null;
    const bytes = platform.file(extensionId, path);
    if (!bytes) return null;
    let url = urls.get(bytes);
    if (!url) {
      try { url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' })); } catch { return null; }
      urls.set(bytes, url);
    }
    return url;
  }, [platform, extensionId, path, revision]);
}
