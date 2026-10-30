// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { BackSide, Color, FrontSide, MeshLambertMaterial, RepeatWrapping, SRGBColorSpace, Texture, TextureLoader } from 'three';
import type { RenderMaterial } from '../types';
import { FACE_MATERIAL_COMMON, FADE_OPACITY, patchSelectTint } from '../renderables/BodyRenderable';
import { colorizePixels, type ColorizeType } from '@pushform/model';

type TextureImage = CanvasImageSource & { width: number; height: number };

/**
 * Texture images by URL (object/data URLs from the model's `ImageStore`): one `THREE.Texture`
 * per URL with repeat wrapping, sRGB and anisotropic filtering. `onLoad` fires when an image
 * finished loading so the viewport can redraw.
 */
export class TextureCache {
  private textures = new Map<string, Texture>();
  /** Colorized copies by `url|color|type`, drawn once the URL's image has loaded. */
  private colorizedTextures = new Map<string, { url: string; texture: Texture }>();
  private waiting = new Map<string, ((image: TextureImage) => void)[]>();
  private loading = new Map<string, { ready: Promise<boolean>; settle: (ok: boolean) => void }>();
  private loader: TextureLoader | null = null;
  private anisotropy = 1;
  onLoad: (() => void) | null = null;

  get(url: string): Texture {
    const cached = this.textures.get(url);
    if (cached) return cached;
    this.loader ??= new TextureLoader();
    let settle!: (ok: boolean) => void;
    const ready = new Promise<boolean>(resolve => { settle = resolve; });
    this.loading.set(url, { ready, settle });
    const tex = this.loader.load(
      url,
      (loaded) => {
        settle(true);
        const waiting = this.waiting.get(url);
        this.waiting.delete(url);
        waiting?.forEach((apply) => apply(loaded.image as TextureImage));
        this.onLoad?.();
      },
      undefined,
      () => { settle(false); },
    );
    this.configure(tex);
    this.textures.set(url, tex);
    return tex;
  }

  /** Wait for the current textures before a one-shot export; failures must not become permanent blank previews. */
  async whenReady(timeoutMs = 30_000, urls: Iterable<string> = this.loading.keys()): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const loaded = await Promise.race([Promise.all([...urls].map(url => this.loading.get(url)?.ready ?? true)),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Texture loading timed out.')), timeoutMs); })]);
      if (loaded.some(ok => !ok)) throw new Error('A texture could not be loaded.');
    } finally { clearTimeout(timer); }
  }

  /**
   * The image at `url` colorized toward the CSS `color`. It is empty until the image
   * has loaded, and shows the image colors where no 2D canvas is available.
   */
  colorized(url: string, color: string, type: ColorizeType): Texture {
    const key = `${url}|${color}|${type}`;
    const cached = this.colorizedTextures.get(key);
    if (cached) return cached.texture;
    const tex = new Texture();
    this.configure(tex);
    this.colorizedTextures.set(key, { url, texture: tex });
    const rgb = srgb255(color);
    const apply = (image: TextureImage): void => {
      tex.image = colorizedImage(image, rgb, type) ?? image;
      tex.needsUpdate = true;
    };
    const image = this.get(url).image as TextureImage | null | undefined;
    if (image && image.width > 0 && image.height > 0) apply(image);
    else this.waiting.set(url, [...(this.waiting.get(url) ?? []), apply]);
    return tex;
  }

  private configure(tex: Texture): void {
    tex.wrapS = RepeatWrapping;
    tex.wrapT = RepeatWrapping;
    tex.colorSpace = SRGBColorSpace;
    tex.anisotropy = this.anisotropy;
  }

  has(url: string): boolean {
    return this.textures.has(url);
  }
  get size(): number {
    return this.textures.size;
  }

  /** Max anisotropy of the renderer (`capabilities.getMaxAnisotropy()`); applied to every texture. */
  setMaxAnisotropy(n: number): void {
    this.anisotropy = Math.max(1, n);
    for (const t of [...this.textures.values(), ...[...this.colorizedTextures.values()].map((c) => c.texture)]) {
      t.anisotropy = this.anisotropy;
      t.needsUpdate = true;
    }
  }

  /** Drop textures, and their colorized copies, whose URL is not in `keep`. */
  prune(keep: ReadonlySet<string>): void {
    for (const [url, t] of this.textures) {
      if (keep.has(url)) continue;
      t.dispose();
      this.textures.delete(url);
      this.loading.get(url)?.settle(false); this.loading.delete(url);
      this.waiting.delete(url);
    }
    for (const [key, c] of this.colorizedTextures) {
      if (keep.has(c.url)) continue;
      c.texture.dispose();
      this.colorizedTextures.delete(key);
    }
  }

  dispose(): void {
    for (const t of this.textures.values()) t.dispose();
    for (const c of this.colorizedTextures.values()) c.texture.dispose();
    for (const item of this.loading.values()) item.settle(false);
    this.loading.clear();
    this.textures.clear();
    this.colorizedTextures.clear();
    this.waiting.clear();
  }
}

/** A CSS color's sRGB channels in 0..255 (`Color` itself holds linear values). */
function srgb255(color: string): [number, number, number] {
  const hex = new Color(color).getHex();
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
}

/**
 * A canvas holding `image` colorized toward `rgb`, or null where no 2D canvas is available. `maxSize` reduces it
 * first so its longer side is at most that many pixels.
 */
function colorizedImage(image: TextureImage, rgb: readonly [number, number, number], type: ColorizeType, maxSize = Infinity): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  } catch {
    return null;
  }
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  colorizePixels(data.data, rgb, type);
  ctx.putImageData(data, 0, 0);
  return canvas;
}

export interface TexturedDisplay {
  /** X-ray: every face translucent, no depth write. */
  readonly xray: boolean;
  readonly xrayOpacity: number;
  /** Faces drawn at all (false for wireframe). */
  readonly faces: boolean;
}

/** True when a face side cannot use the shared vertex-colored material (texture or opacity). */
export function needsOwnMaterial(m: RenderMaterial | null | undefined, textured: boolean): m is RenderMaterial {
  return !!m && ((textured && !!m.textureUrl) || m.alpha < 1);
}

/**
 * Lambert materials for textured / translucent faces, one per (material, side, faded, textured)
 * combination. Textured variants sample the map, colorized toward the material color
 * does when `colorize` is set; plain variants are vertex-colored like the shared body materials so a translucent
 * color still shows the face's own color. All carry the selection tint shader patch.
 */
export class TexturedMaterialCache {
  private materials = new Map<string, MeshLambertMaterial>();
  private display: TexturedDisplay = { xray: false, xrayOpacity: 0.35, faces: true };

  constructor(readonly textures: TextureCache) {}

  get(m: RenderMaterial, side: 'front' | 'back', faded: boolean, textured: boolean): MeshLambertMaterial {
    const useMap = textured && !!m.textureUrl;
    const key = `${m.id}|${useMap ? m.textureUrl : ''}|${m.color}|${m.alpha}|${m.colorize ?? ''}|${side}|${faded ? 1 : 0}`;
    let mat = this.materials.get(key);
    if (mat) return mat;
    mat = new MeshLambertMaterial({
      color: 0xffffff,
      vertexColors: !useMap,
      side: side === 'front' ? FrontSide : BackSide,
      ...FACE_MATERIAL_COMMON,
    });
    if (useMap) {
      mat.map = m.colorize
        ? this.textures.colorized(m.textureUrl!, m.color, m.colorize)
        : this.textures.get(m.textureUrl!);
    }
    mat.userData['alpha'] = m.alpha;
    mat.userData['faded'] = faded;
    patchSelectTint(mat);
    this.applyTo(mat);
    this.materials.set(key, mat);
    return mat;
  }

  /** Display flags shared with the body materials (X-ray opacity, face visibility). */
  setDisplay(d: TexturedDisplay): void {
    this.display = d;
    for (const m of this.materials.values()) this.applyTo(m);
  }

  private applyTo(m: MeshLambertMaterial): void {
    const alpha = (m.userData['alpha'] as number | undefined) ?? 1;
    const faded = m.userData['faded'] === true;
    const d = this.display;
    const opacity = d.xray ? Math.min(d.xrayOpacity, alpha) : faded ? Math.min(FADE_OPACITY, alpha) : alpha;
    m.visible = d.faces;
    m.transparent = opacity < 1;
    m.opacity = opacity;
    m.depthWrite = !d.xray;
  }

  get size(): number {
    return this.materials.size;
  }

  dispose(): void {
    for (const m of this.materials.values()) m.dispose();
    this.materials.clear();
  }
}

/**
 * A data URL of the image at `url` colorized toward the CSS `color`, at most `maxSize` pixels on its
 * longer side, for swatches; null when the image cannot be loaded or no 2D canvas is available.
 */
export function colorizedImageUrl(url: string, color: string, type: ColorizeType, maxSize = 128): Promise<string | null> {
  if (typeof Image === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = (): void => {
      try {
        resolve(colorizedImage(image, srgb255(color), type, maxSize)?.toDataURL() ?? null);
      } catch {
        resolve(null);
      }
    };
    image.onerror = (): void => resolve(null);
    image.src = url;
  });
}
