// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import {
  CommandRegistry,
  DocumentHost,
  SERVICE_DOCUMENT,
  SERVICE_KERNEL,
  axesCommands,
  clipboardCommands,
  componentBehaviorCommands,
  componentCommands,
  contextCommands,
  curveCommands,
  dimensionCommands,
  edgeCommands,
  editCommands,
  fogCommands,
  followMeCommands,
  groupCommands,
  guideCommands,
  imageCommands,
  intersectCommands,
  lastOpCommands,
  materialCommands,
  modelCommands,
  modelInfoCommands,
  offsetCommands,
  pushPullCommands,
  shadowCommands,
  sketchCommands,
  solidCommands,
  styleCommands,
  tagCommands,
  textCommands,
  transformCommands,
  viewCommands,
  type AnyCommand,
} from '@pushform/commands';
import { openModelFile, encodeModelSnapshot, modelArchiveImages } from '@pushform/io';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import { Document } from '@pushform/model';

/**
 * The command sets a headless session registers: every model command set of the app
 * except camera and scenes, which need a viewport. Display, active-material and clipboard state
 * fall back to in-memory hosts when a command first asks for them.
 */
export const HEADLESS_COMMAND_SETS: readonly (readonly AnyCommand[])[] = [
  editCommands, modelCommands, sketchCommands, clipboardCommands, imageCommands, pushPullCommands, curveCommands,
  transformCommands, viewCommands, lastOpCommands, edgeCommands, guideCommands, dimensionCommands, textCommands,
  axesCommands, offsetCommands, followMeCommands, solidCommands, intersectCommands, contextCommands, groupCommands,
  componentBehaviorCommands, tagCommands, styleCommands, shadowCommands, fogCommands, materialCommands,
  modelInfoCommands, componentCommands,
];

/** One open model: its document host and the registry that edits it, on the inline kernel. */
export class HeadlessModel {
  readonly host: DocumentHost;
  readonly registry: CommandRegistry;

  constructor(
    readonly kernel: KernelClient,
    doc: Document = new Document(),
  ) {
    this.host = new DocumentHost(doc);
    this.registry = new CommandRegistry({
      tx: this.host,
      services: new Map<string, unknown>([
        [SERVICE_DOCUMENT, this.host],
        [SERVICE_KERNEL, kernel],
      ]),
    });
    for (const set of HEADLESS_COMMAND_SETS) this.registry.registerAll(set);
  }

  /** The .pf bytes of the model, with the image bytes the session holds (MOD/CLD .pf format). */
  encode(): Promise<Uint8Array> {
    const state = this.host.doc.state;
    return encodeModelSnapshot(state, modelArchiveImages(state, this.host.images));
  }
}

/**
 * A headless session: one model at a time. Opening a file or starting a new model
 * replaces the model and its undo history; the kernel is shared and lives for the session.
 */
export class HeadlessSession {
  readonly kernel: KernelClient;
  model: HeadlessModel;
  /** The file the model was opened from or last saved to, if any. */
  path: string | null = null;

  constructor(kernel: KernelClient = new KernelClient(new InlineBackend())) {
    this.kernel = kernel;
    this.model = new HeadlessModel(kernel);
  }

  newModel(): void {
    this.model = new HeadlessModel(this.kernel);
    this.path = null;
  }

  /** Replace the model with a decoded .pf file. Throws on an invalid file, leaving the current model. */
  async load(bytes: Uint8Array, path: string | null = null): Promise<void> {
    const file = await openModelFile(bytes);
    const model = new HeadlessModel(this.kernel, new Document(file.state));
    for (const [id, blob] of file.images) {
      const asset = file.state.images.get(id);
      if (asset) model.host.images.register(asset, blob.bytes, blob.mime);
    }
    this.model = model;
    this.path = path;
  }

  dispose(): void {
    this.kernel.dispose();
  }
}
