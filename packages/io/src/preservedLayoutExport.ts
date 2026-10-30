// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { strFromU8, strToU8 } from 'fflate';
import { isViewport, layoutModelConnectionSnapshot, viewportCamerasEqual, type LayoutDocumentState, type LayoutEntity, type LayoutViewport, isCloudSource } from '@pushform/layout';
import { readOriginalLayoutArchive } from './layoutModelArchive';
import { readNativeArchive } from './nativeArchive';
import { layOutCameraFromViewport, readLayOutCamera, viewportCameraFromLayOut } from './sketchupViewportCamera';
import { child, parseXml, type XmlElement } from './xml';

const REFERENCE_NS = 'http://sketchup.google.com/schemas/layout/1.0/references';
const LAYOUT_NS = 'http://sketchup.google.com/schemas/layout/1.0/layout';
const PREFIXES = { [REFERENCE_NS]: 'r', [LAYOUT_NS]: 'l' };
const MM_PER_INCH = 25.4;
const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const walk = (node: XmlElement): XmlElement[] => [node, ...node.children.flatMap(walk)];
const markup = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<(?:"[^"]*"|'[^']*'|[^'">])*>/g;
/** Plain decimal text: LayOut's XML never uses exponent notation. */
const numberText = (value: number) => {
  const text = (Math.abs(value) < 5e-13 ? 0 : value).toFixed(12).replace(/\.?0+$/, '');
  return text === '-0' ? '0' : text;
};
function standalone(node: XmlElement, xml: string): string {
  const opening = xml.match(/^<(?:"[^"]*"|'[^']*'|[^'">])*>/)?.[0] ?? '';
  const declared = new Set([...opening.matchAll(/\sxmlns(?::([^\s=]+))?\s*=/g)].map(match => match[1] ?? ''));
  const missing = Object.entries(node.source!.namespaces).filter(([prefix]) => !declared.has(prefix))
    .map(([prefix, uri]) => ` xmlns${prefix ? `:${prefix}` : ''}="${escape(uri)}"`).join('');
  return xml.replace(/^(<[^\s/>]+)/, `$1${missing}`);
}

/** Sets one attribute on the first tag of `xml` whose local name is `tag`. */
function setAttributes(xml: string, tag: string, values: Record<string, string>): string {
  return xml.replace(new RegExp(`<([\\w.-]+:)?${tag}\\b(?:"[^"]*"|'[^']*'|[^'">])*>`), opening => {
    let result = opening;
    for (const [name, value] of Object.entries(values)) {
      const attribute = new RegExp(`(\\s${name}\\s*=\\s*)("[^"]*"|'[^']*')`);
      result = attribute.test(result) ? result.replace(attribute, `$1"${escape(value)}"`) : result.replace(/(\/?>)$/, ` ${name}="${escape(value)}"$1`);
    }
    return result;
  });
}

/** Sets the value of a `renderingOptions` entry the XML already has; LayOut writes the render-mode entries for every view. */
function setRenderingOption(xml: string, key: string, value: string): string {
  return xml.replace(new RegExp(`(<(?:[\\w.-]+:)?entry\\b[^>]*\\skey="${key}"[^>]*\\svalue=)("[^"]*"|'[^']*')`), `$1"${value}"`);
}

const isRenderCache = (reference: XmlElement) => reference.name === 'imageFileReference' || reference.name === 'vectorFileReference';

interface ArchiveContext {
  files: Record<string, Uint8Array>; references: Map<string, XmlElement>; idMap: Map<string, string>; directory: string;
  copied: Set<string>; exportedReferences: Set<string>; originals: Map<string, XmlElement>;
  connections: Map<string, XmlElement[]>;
}

export interface ViewportPlacement { xml: string; rect: [number, number, number, number]; width: number; height: number }

/**
 * Writes PushForm viewports as LayOut model entities. An imported viewport whose frame and camera
 * are unchanged is written exactly as LayOut saved it; edited viewports, copies and new views reuse their
 * template's settings with the new frame, crop and camera, and leave their render caches stale for LayOut to
 * render again. Anything that cannot be restored safely falls back to the cached picture, with a report.
 */
export class PreservedLayoutExport {
  private readonly archives = new Map<string, ArchiveContext | null>();
  private stale = 0;
  private readonly now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  private state: LayoutDocumentState | undefined;
  private readonly entities = new Map<number, LayoutEntity>();
  private readonly homes = new Map<number, number | null>();
  private readonly writtenViews = new Map<number, string>();
  private readonly writtenAnnotations = new Map<number, { id: string; entityIds: Map<string, string> }>();

  constructor(private readonly allocate: () => string, private readonly output: Record<string, Uint8Array>,
    private readonly outputReferences: string[], private readonly warn: (message: string) => void,
    private readonly placement: (entity: LayoutEntity) => ViewportPlacement | null) {}

  prepare(state: LayoutDocumentState): void {
    this.state = state;
    for (const entity of [...state.sharedEntities.values(), ...[...state.pages.values()].flatMap(page => [...page.entities.values()])])
      this.entities.set(entity.id, entity);
    for (const id of state.sharedEntities.keys()) this.homes.set(id, null);
    for (const page of state.pages.values()) for (const id of page.entities.keys()) this.homes.set(id, page.id);
    let index = 0;
    for (const [archiveId] of state.modelArchives ?? []) {
      try {
        const files = readNativeArchive(readOriginalLayoutArchive(state, archiveId), { extension: '.layout', supported: () => true });
        const referenceRoot = parseXml(strFromU8(files['references.xml']!), PREFIXES, name => name.endsWith('FileReference'));
        const references = new Map(referenceRoot.children.map(node => [node.attrs['r:id'] ?? '', node]));
        const originals = new Map<string, XmlElement>();
        const connections = new Map<string, XmlElement[]>();
        for (const [path, content] of Object.entries(files)) {
          if (path !== 'document.xml' && !/^pages\/[^/]+\.xml$/i.test(path)) continue;
          for (const node of walk(parseXml(strFromU8(content), PREFIXES, name => ['skpModelRef', 'linearDimension', 'label', 'connection'].includes(name)))) {
            if (['skpModelRef', 'linearDimension', 'label'].includes(node.name) && node.attrs.id) originals.set(node.attrs.id, node);
            if (node.name === 'connection' && child(node, 'sketchupConnectionPoint')) {
              const owner = child(node, 'dimensionConnectionPoint') ?? child(node, 'labelConnectionPoint');
              const id = owner?.attrs['l:ref'];
              if (id) connections.set(id, [...connections.get(id) ?? [], node]);
            }
          }
        }
        this.archives.set(archiveId, { files, references, originals, connections, idMap: new Map(), directory: `preserved-layout/${++index}/`, copied: new Set(), exportedReferences: new Set() });
        if (connections.size && state.modelArchives!.get(archiveId)!.annotationConnectionsVersion === undefined)
          this.warn('This drawing was imported before model connections were preserved; original model annotation connections may be missing');
      } catch {
        this.archives.set(archiveId, null);
        this.warn('An original model package could not be restored; its viewports are exported as cached appearance');
      }
    }
  }

  /** LayOut XML for a viewport, or null for other objects and for viewports exported as their cached picture. */
  entity(entity: LayoutEntity): [string, string][] | null {
    if (entity.preservedModelConnections) return this.annotation(entity);
    if (!isViewport(entity)) return null;
    const viewport = entity.image.viewport;
    if (isCloudSource(viewport.source) || viewport.templateId === null) {
      // A cloud model has no .skp to embed: its view is exported as its picture.
      this.warn('A view of a PushForm cloud model was exported as its picture; LayOut cannot edit it as a model viewport');
      return null;
    }
    const archive = this.archives.get(viewport.source.archiveId);
    const template = archive?.originals.get(viewport.templateId);
    if (!archive || !template?.source) {
      if (archive !== null) this.warn('A SketchUp viewport has no original model package and was exported as cached appearance');
      return null;
    }
    try {
      // Resize mode alone changes no camera, rendering resource or model-annotation dependency.
      const xml = setAttributes(this.untouched(entity, viewport, template) ? template.source.xml : this.patched(entity, viewport, template, archive),
        'skpModelRef', { constantSize: viewport.preserveScaleOnResize === false ? '0' : '1' });
      const node = parseXml(standalone(template, xml), PREFIXES, name => name === 'skpModelRef');
      this.checkDependencies(node, archive, new Set());
      this.copyDependencies(node, archive);
      // Each exported viewport has its own entity ids, so copies of one original never collide.
      const entityIds = new Map<string, string>();
      const id = this.remap(node.attrs.id!, archive, entityIds);
      this.writtenViews.set(entity.id, id);
      return [[id, `      ${standalone(template, this.rewrite(xml, archive, template.source.namespaces, entityIds, true))}\n`]];
    } catch {
      this.warn('A SketchUp viewport has unsupported or missing dependencies and was exported as cached appearance');
      return null;
    }
  }

  /** Unchanged imported annotations retain their own geometry, text, automatic scale and opaque settings. */
  private annotation(entity: LayoutEntity): [string, string][] | null {
    const saved = entity.preservedModelConnections!;
    const archive = this.archives.get(saved.archiveId), original = archive?.originals.get(saved.originalId);
    const connections = archive?.connections.get(saved.originalId);
    try {
      if (!archive || !original?.source || !connections?.length || saved.snapshot !== layoutModelConnectionSnapshot(entity)) throw new Error('Changed annotation');
      for (const connection of connections) {
        const originalId = child(connection, 'sketchupConnectionPoint')?.attrs['l:ref'];
        const mapped = saved.viewports.find(view => view.originalId === originalId);
        const view = mapped && this.entities.get(mapped.entityId), template = originalId && archive.originals.get(originalId);
        if (!isViewport(view) || view.hidden || !template || isCloudSource(view.image.viewport.source) ||
          this.homes.get(view.id) !== null && this.homes.get(view.id) !== this.homes.get(entity.id) ||
          view.image.viewport.source.archiveId !== saved.archiveId || view.image.viewport.originalId !== originalId ||
          view.image.viewport.source.modelReferenceId !== this.state?.modelArchives?.get(saved.archiveId)?.viewports.get(originalId!)?.modelReferenceId ||
          view.image.viewport.scene !== (template.attrs.cameraModified === '1' ? null : template.attrs.defaultPageName ?? null) ||
          !this.untouched(view, view.image.viewport, template)) throw new Error('Changed model view');
      }
      this.checkDependencies(original, archive, new Set());
      this.copyDependencies(original, archive);
      const entityIds = new Map<string, string>();
      const id = this.remap(saved.originalId, archive, entityIds);
      const xml = standalone(original, this.rewrite(original.source.xml, archive, original.source.namespaces, entityIds, true));
      this.writtenAnnotations.set(entity.id, { id, entityIds });
      return [[id, `      ${xml}\n`]];
    } catch {
      this.warn('An imported model annotation or its view changed; its appearance was exported without its original model connection');
      return null;
    }
  }

  /** Called after all pages and shared objects have been written, when every view's exported identity is known. */
  connections(entity: LayoutEntity): string[] {
    const saved = entity.preservedModelConnections, written = this.writtenAnnotations.get(entity.id);
    if (!saved || !written) return [];
    const archive = this.archives.get(saved.archiveId)!;
    const mapping = new Map(written.entityIds);
    for (const view of saved.viewports) {
      const id = this.writtenViews.get(view.entityId);
      if (!id) { this.warn('An imported annotation model view could not be exported; its model connection was omitted'); return []; }
      mapping.set(view.originalId, id);
    }
    return (archive.connections.get(saved.originalId) ?? []).map(connection =>
      standalone(connection, this.rewrite(connection.source!.xml, archive, connection.source!.namespaces, mapping)) + '\n');
  }

  /** The original viewport, with its frame and camera as LayOut saved them. */
  private untouched(entity: LayoutEntity, viewport: LayoutViewport, template: XmlElement): boolean {
    const base = child(child(template, 'placedFileReference') ?? template, 'rectangleBase');
    const camera = child(template, 'camera') ?? { name: 'camera', attrs: {}, children: [], text: '' };
    if (viewport.originalId !== viewport.templateId || !base) return false;
    const n = (key: string, fallback: number, element = base) => Number(element.attrs[key] ?? fallback);
    const x = n('x', 0), y = n('y', 0), width = n('width', 0), height = n('height', 0);
    const matrix = child(base, 'affineTransform');
    const t = (u: number, v: number) => matrix
      ? [n('m11', 1, matrix) * u + n('m12', 0, matrix) * v + n('tx', 0, matrix), n('m21', 0, matrix) * u + n('m22', 1, matrix) * v + n('ty', 0, matrix)]
      : [u, v];
    const frame = [t(x, y), t(x + width, y), t(x + width, y + height), t(x, y + height)];
    const sameFrame = frame.every((point, i) => entity.points[i] &&
      Math.abs(point[0]! * MM_PER_INCH - entity.points[i]![0]) < 1e-4 && Math.abs(point[1]! * MM_PER_INCH - entity.points[i]![1]) < 1e-4);
    return sameFrame && viewportCamerasEqual(viewport.camera, viewportCameraFromLayOut(readLayOutCamera(camera), width, height), 1e-9);
  }

  /** The template's settings with this viewport's frame, crop and camera; its caches become stale. */
  private patched(entity: LayoutEntity, viewport: LayoutViewport, template: XmlElement, archive: ArchiveContext): string {
    const placed = this.placement(entity);
    const xml = template.source!.xml;
    const prefix = /^<([\w.-]+:)?skpModelRef/.exec(xml)?.[1] ?? '';
    if (!placed) throw new Error('Viewport has no frame');
    const templateCamera = child(template, 'camera');
    const camera = layOutCameraFromViewport(viewport.camera, placed.width, placed.height, Number(templateCamera?.attrs.fov ?? 30));
    const changedCamera = !templateCamera || !viewportCamerasEqual(viewport.camera,
      viewportCameraFromLayOut(readLayOutCamera(templateCamera), placed.width, placed.height), 1e-9);
    let result = xml.replace(new RegExp(`<${prefix}placedFileReference\\b[\\s\\S]*?</${prefix}placedFileReference>`),
      placed.xml.trim().replace(/<(\/?)e:/g, `<$1${prefix}`));
    result = setAttributes(result, 'skpModelRef', {
      ...(viewport.scene !== null ? { defaultPageName: viewport.scene } : {}),
      ...(changedCamera || viewport.scene === null ? { cameraModified: '1' } : {}),
    });
    result = setAttributes(result, 'camera', {
      projection: camera.perspective ? '0' : '1', fov: numberText(camera.fov),
      ...(camera.perspective ? {} : { height: numberText(camera.height) }),
      twoDCamera: camera.twoDCamera ? '1' : '0', twoDScale: numberText(camera.twoDScale),
      twoDxCenter: numberText(camera.twoDxCenter), twoDyCenter: numberText(camera.twoDyCenter),
    });
    for (const [name, value] of [['eye', camera.eye], ['target', camera.target], ['up', camera.up]] as const)
      result = setAttributes(result, name, { x: numberText(value[0]), y: numberText(value[1]), z: numberText(value[2]) });
    const [rx, ry, rw, rh] = placed.rect;
    result = setAttributes(result, 'imageRect', { x: numberText(rx), y: numberText(ry), width: numberText(rw), height: numberText(rh) });
    // A new view or a copy renders in Raster. LayOut keeps a view's render mode in HLRDrawingStyle
    // (0 Raster, 1 Hybrid, 2 Vector) and OutputFaces (1 only for Vector). An edited imported view keeps its mode,
    // which LayOut renders again from the model.
    if (viewport.originalId === null) {
      result = setRenderingOption(result, 'HLRDrawingStyle', '0');
      result = setRenderingOption(result, 'OutputFaces', '0');
    }
    // Point the render caches at fresh stale references, the way LayOut marks a viewport that needs rendering.
    return result.replace(/<([\w.-]+:)?(imageFileReference|vectorFileReference)\b(?:"[^"]*"|'[^']*'|[^'">])*>/g, (tag, _prefix: string | undefined, kind: string) => {
      const id = `pushform-stale-${++this.stale}`;
      const originalId = /\s[\w.-]+:id\s*=\s*"([^"]*)"/.exec(tag)?.[1];
      const original = originalId ? archive.references.get(originalId) : undefined;
      // Keep the original record's other attributes (LayOut expects its dates), marked stale.
      const xml = original?.source
        ? setAttributes(original.source.xml.replace(/(\s[\w.-]+:id\s*=\s*)("[^"]*"|'[^']*')/, `$1"${id}"`), kind, { type: '3', internalTarget: '' })
        : `<r:${kind} r:id="${id}" type="3" internalTarget="" externalTarget="" modificationDate="${this.now}" insertDate="${this.now}"/>`;
      archive.references.set(id, {
        name: kind, attrs: { 'r:id': id, type: '3', internalTarget: '' }, children: [], text: '',
        source: { xml, namespaces: original?.source?.namespaces ?? { r: REFERENCE_NS }, ancestors: [] },
      });
      return tag.replace(/(\s[\w.-]+:id\s*=\s*)("[^"]*"|'[^']*')/, `$1"${id}"`);
    });
  }

  private remap(id: string, archive: ArchiveContext, ids = archive.idMap): string {
    if (!ids.has(id)) ids.set(id, this.allocate());
    return ids.get(id)!;
  }

  /**
   * File references a subtree uses. Most point into references.xml by `r:id`; some, such as a viewport's
   * style file, are inline: the element carries its own target and is not listed in references.xml.
   */
  private referenceIds(node: XmlElement): { id: string; inline: XmlElement | null }[] {
    return walk(node).flatMap(item => item.attrs['r:id'] ? [{ id: item.attrs['r:id'],
      inline: 'internalTarget' in item.attrs || 'externalTarget' in item.attrs ? item : null }] : []);
  }

  private checkDependencies(node: XmlElement, archive: ArchiveContext, seen: Set<string>): void {
    const declared = new Set(walk(node).flatMap(item => item.attrs.id ? [item.attrs.id] : []));
    for (const item of walk(node)) {
      if (item.attrs['l:ref'] && !declared.has(item.attrs['l:ref'])) throw new Error('External entity dependency');
    }
    for (const { id, inline } of this.referenceIds(node)) {
      if (seen.has(id)) continue;
      seen.add(id);
      const reference = inline ?? archive.references.get(id);
      if (!reference || !inline && !reference.source) throw new Error('Missing reference');
      const target = reference.attrs.internalTarget;
      if (target) {
        this.safeTarget(target);
        const bytes = archive.files[target];
        if (!bytes && !inline && isRenderCache(reference)) continue;
        if (!bytes) throw new Error('Missing embedded resource');
        if (/\.xml$/i.test(target)) this.checkDependencies(parseXml(strFromU8(bytes), PREFIXES), archive, seen);
      }
    }
  }

  private safeTarget(target: string): void {
    if (!target || target.includes('\\') || target.startsWith('/') || /^[a-z]:/i.test(target) || target.split('/').some(part => part === '..' || part === '.'))
      throw new Error('Invalid archive target');
  }

  private copyDependencies(node: XmlElement, archive: ArchiveContext): void {
    for (const { id, inline } of this.referenceIds(node)) {
      const reference = inline ?? archive.references.get(id)!;
      const target = reference.attrs.internalTarget;
      // LayOut opens documents whose cached renders were left out and renders them again;
      // such a cache is written the way LayOut writes a stale one: type 3 with no target.
      const missing = !!target && !archive.files[target];
      if (target && !missing && !archive.copied.has(target)) {
        archive.copied.add(target);
        const bytes = archive.files[target]!;
        if (/\.xml$/i.test(target)) {
          const xml = strFromU8(bytes);
          this.copyDependencies(parseXml(xml, PREFIXES), archive);
          // Cached vector files have their own local entity-id space; file reference ids remain global.
          this.output[archive.directory + target] = strToU8(this.rewrite(xml, archive, {}, new Map()));
        } else if (!/\.style$/i.test(target)) this.output[archive.directory + target] = bytes;
      }
      // An inline reference is rewritten in place with the markup that contains it.
      if (inline || archive.exportedReferences.has(id)) continue;
      archive.exportedReferences.add(id);
      let xml = this.rewrite(reference.source!.xml, archive, reference.source!.namespaces);
      if (missing) xml = xml.replace(/\sinternalTarget\s*=\s*("[^"]*"|'[^']*')/, ' internalTarget=""').replace(/\stype\s*=\s*("[^"]*"|'[^']*')/, ' type="3"');
      this.outputReferences.push(standalone(reference, xml));
    }
  }

  /**
   * Only markup attributes are rewritten; RTF, text, and opaque binary resources remain intact. Entity ids
   * use `entityIds`; reference ids are shared across the package, except inline references in entity markup
   * (`inlineLocal`), which each copy declares itself.
   */
  private rewrite(xml: string, archive: ArchiveContext, namespaces: Record<string, string> = {}, entityIds = archive.idMap, inlineLocal = false): string {
    const scopes = [namespaces];
    return xml.replace(markup, tag => {
      if (tag.startsWith('<!') || tag.startsWith('<?')) return tag;
      if (tag.startsWith('</')) { if (scopes.length > 1) scopes.pop(); return tag; }
      const scope = { ...scopes.at(-1) };
      for (const match of tag.matchAll(/\sxmlns(?::([^\s=]+))?\s*=\s*("[^"]*"|'[^']*')/g))
        scope[match[1] ?? ''] = parseXml(`<value attr=${match[2]}/>`).attrs.attr!;
      const inline = inlineLocal && /\s(?:internalTarget|externalTarget)\s*=/.test(tag);
      const attributes = [...tag.matchAll(/([\w:.-]+)\s*=\s*("[^"]*"|'[^']*')/g)];
      const styleReference = attributes.find(([, key]) => key!.split(':').at(-1) === 'id' &&
        key!.includes(':') && scope[key!.split(':')[0]!] === REFERENCE_NS);
      const rewritten = tag.replace(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g, (whole, key: string, quoted: string) => {
        const local = key.split(':').at(-1);
        const prefix = key.includes(':') ? key.split(':')[0]! : null;
        const reference = local === 'id' && prefix !== null && scope[prefix] === REFERENCE_NS;
        const identity = key === 'id' || reference || local === 'ref' && prefix !== null && scope[prefix] === LAYOUT_NS;
        if (!identity && key !== 'internalTarget') return whole;
        const value = parseXml(`<value attr=${quoted}/>`).attrs.attr ?? '';
        if (identity && value) return `${key}="${escape(this.remap(value, archive, reference && !inline ? archive.idMap : entityIds))}"`;
        if (key === 'internalTarget' && value) {
          if (/\.style$/i.test(value) && styleReference && archive.files[value]) {
            // LayOut's native re-save regenerates styles under ref/ using the reference's numeric ID.
            // A nested preservation path can leave its regenerated target absent from the saved ZIP.
            const sourceId = parseXml(`<value attr=${styleReference[2]}/>`).attrs.attr!;
            const id = this.remap(sourceId, archive, inline ? entityIds : archive.idMap);
            const stem = value.split('/').at(-1)!.replace(/(?:_\d+)?\.style$/i, '');
            const target = `ref/${stem}_${id.replace(/^id/, '')}.style`;
            this.output[target] = archive.files[value]!;
            return `${key}="${escape(target)}"`;
          }
          return `${key}="${escape(archive.directory + value)}"`;
        }
        return whole;
      });
      if (!/\/\s*>$/.test(tag)) scopes.push(scope);
      return rewritten;
    });
  }
}
