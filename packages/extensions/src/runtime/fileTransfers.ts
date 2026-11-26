// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import {
  ExtensionError, FILE_TRANSFER_LIMITS as LIMITS, fileOpenReadSchema, fileReadChunkSchema, fileCloseReadSchema,
  fileStageSchema, fileDiscardSchema, fileSaveStagedSchema, sha256Hex,
  type ExtensionManifest, type FileReadDescription, type FileReadChunk, type FileStageResult,
} from '@pushform/extension-protocol';
import type { z } from 'zod';
import { fileRequest, type FilePicker } from './io';
import type { ServiceImplementations } from './host';

type Common = { size: number; expires: number; controller: AbortController };
type Opening = Common & { kind: 'opening' };
type Reading = Common & { kind: 'read'; description: FileReadDescription; bytes: Uint8Array };
type Saving = Common & { kind: 'save'; bytes: Uint8Array; received: number; sha256: string; busy: boolean };
type Transfer = Opening | Reading | Saving;
const invalid = (message: string): never => { throw new ExtensionError('validation.failed',message); };
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  return result.success ? result.data : invalid('The file transfer request is invalid or exceeds its limits.');
}

/** Captured file bytes and export staging belong only to this extension runtime; no live filesystem handles escape. */
export class ExtensionFileTransfers {
  private readonly transfers = new Map<string,Transfer>();
  private readonly lifetime = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly manifest: ExtensionManifest, private readonly picker: FilePicker, private readonly now = () => Date.now()) {}

  services(): ServiceImplementations {
    return {
      'files.openRead': (input,call) => this.open(parse(fileOpenReadSchema,input),call.signal),
      'files.read': (input,call) => {
        this.live(call.signal); this.reap();
        const query = parse(fileReadChunkSchema,input), saved = this.transfers.get(query.transfer);
        if (saved?.kind !== 'read') return invalid('This captured file is unavailable or expired. Choose it again.');
        if (query.offset > saved.bytes.length) return invalid('The file offset exceeds its byte count.');
        const end = Math.min(query.offset + query.limit,saved.bytes.length);
        return { transfer:query.transfer,bytes:saved.bytes.slice(query.offset,end),next:end < saved.bytes.length ? end : null } satisfies FileReadChunk;
      },
      'files.closeRead': (input,call) => {
        this.live(call.signal); this.release(parse(fileCloseReadSchema,input).transfer); return null;
      },
      'files.stage': (input,call) => { this.live(call.signal); return this.stage(parse(fileStageSchema,input)); },
      'files.saveStaged': (input,call) => this.save(parse(fileSaveStagedSchema,input),call.signal),
      'files.discard': (input,call) => { this.live(call.signal); this.release(parse(fileDiscardSchema,input).upload); return null; },
    };
  }

  dispose(): void {
    this.lifetime.abort(new ExtensionError('cancelled','The file transfer session has ended.'));
    for (const transfer of this.transfers.values()) transfer.controller.abort();
    this.transfers.clear();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
  /** Trusted snapshot of a user-chosen file owned by this runtime. Paths and live handles never escape. */
  capturedBytes(transfer: string, signal: AbortSignal): Uint8Array {
    this.live(signal); this.reap();
    const saved = this.transfers.get(transfer);
    if (saved?.kind !== 'read') return invalid('This captured file is unavailable or expired. Choose it again.');
    return saved.bytes.slice();
  }
  private live(signal: AbortSignal): void { signal.throwIfAborted(); this.lifetime.signal.throwIfAborted(); }
  private reserve(size: number): Common {
    this.reap();
    const used = [...this.transfers.values()].reduce((sum,item) => sum + item.size,0);
    if (this.transfers.size >= LIMITS.transfers || used + size > LIMITS.sessionBytes)
      throw new ExtensionError('limit.exceeded','File transfers are full. Close or discard another transfer first.');
    return { size,expires:this.now() + LIMITS.lifetimeMs,controller:new AbortController() };
  }
  private async open(input: z.infer<typeof fileOpenReadSchema>, signal: AbortSignal): Promise<FileReadDescription> {
    this.live(signal);
    const request = fileRequest(input,'open',this.manifest.name), reserved: Opening = { ...this.reserve(LIMITS.fileBytes),kind:'opening' };
    const handle = `read_${crypto.randomUUID().replaceAll('-','')}`;
    this.transfers.set(handle,reserved); this.reap();
    const active = AbortSignal.any([signal,this.lifetime.signal,reserved.controller.signal]);
    let captured = false;
    try {
      const chosen = await this.picker.open(request,{ signal:active,maxBytes:LIMITS.fileBytes });
      this.reap(); active.throwIfAborted();
      if (!chosen) throw new ExtensionError('cancelled','No file was chosen.');
      if (chosen.data.length > LIMITS.fileBytes) throw new ExtensionError('limit.exceeded','The chosen file exceeds 64 MiB.');
      const bytes = chosen.data.slice(), sha256 = await sha256Hex(bytes);
      this.reap(); active.throwIfAborted();
      const description = { transfer:handle,name:chosen.name,type:chosen.type,byteLength:bytes.length,sha256 };
      this.transfers.set(handle,{ ...reserved,kind:'read',size:bytes.length,bytes,description }); captured = true;
      return structuredClone(description);
    } finally { if (!captured) this.release(handle); else this.reap(); }
  }
  private stage(input: z.infer<typeof fileStageSchema>): FileStageResult {
    this.reap(); let handle = input.upload, upload: Saving;
    if (handle) {
      const existing = this.transfers.get(handle);
      if (existing?.kind !== 'save') return invalid('This file upload is unavailable or expired.');
      if (input.byteLength !== undefined || input.sha256 !== undefined) return invalid('A file upload cannot change its captured byte count or checksum.');
      upload = existing;
    } else {
      if (input.byteLength === undefined || !input.sha256 || input.offset !== 0) return invalid('A new upload needs its byte count, checksum and offset zero.');
      if (input.bytes.length > input.byteLength) return invalid('The file chunk exceeds the declared size.');
      upload = { ...this.reserve(input.byteLength),kind:'save',bytes:new Uint8Array(input.byteLength),received:0,sha256:input.sha256,busy:false };
      handle = `save_${crypto.randomUUID().replaceAll('-','')}`; this.transfers.set(handle,upload);
    }
    if (upload.busy || input.offset !== upload.received || upload.received + input.bytes.length > upload.size)
      return invalid('File chunks must be sequential and fit the declared size.');
    upload.bytes.set(input.bytes,upload.received); upload.received += input.bytes.length; this.reap();
    return { upload:handle,received:upload.received,complete:upload.received === upload.size };
  }
  private async save(input: z.infer<typeof fileSaveStagedSchema>, signal: AbortSignal): Promise<{ name: string }> {
    this.live(signal); this.reap();
    const request = fileRequest(input,'save',this.manifest.name), upload = this.transfers.get(input.upload);
    if (upload?.kind !== 'save' || upload.busy || upload.received !== upload.size) return invalid('Saving needs a complete, available upload.');
    const active = AbortSignal.any([signal,this.lifetime.signal,upload.controller.signal]); upload.busy = true;
    try {
      if (await sha256Hex(upload.bytes) !== upload.sha256) { this.release(input.upload); return invalid('The staged file failed its complete content checksum.'); }
      this.reap(); active.throwIfAborted();
      const saved = await this.picker.save(request,upload.bytes,{ signal:active,maxBytes:LIMITS.fileBytes });
      if (!saved) { active.throwIfAborted(); throw new ExtensionError('cancelled','The file was not saved.'); }
      // The host picker may already have atomically closed the file when cancellation arrives. Never undo that save.
      this.release(input.upload); return { name:saved.name };
    } finally { upload.busy = false; this.reap(); }
  }
  private release(handle: string): void {
    this.transfers.get(handle)?.controller.abort(); this.transfers.delete(handle); this.reap();
  }
  private reap(): void {
    if (this.timer !== null) clearTimeout(this.timer); this.timer = null;
    if (this.lifetime.signal.aborted) return;
    const now = this.now();
    for (const [handle,transfer] of this.transfers) if (transfer.expires <= now) { transfer.controller.abort(); this.transfers.delete(handle); }
    if (this.transfers.size) this.timer = setTimeout(() => this.reap(),Math.max(1,Math.min(...[...this.transfers.values()].map(item => item.expires)) - now));
  }
}
