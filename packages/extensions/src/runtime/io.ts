// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { ExtensionError, type ExtensionManifest, type ExtensionPermission } from '@pushform/extension-protocol';
import type { ServiceCall, ServiceImplementations } from './host';

/**
 * Files, clipboard and network for extensions. None of them gives an extension a path, a handle that outlives one
 * call, a way to read the clipboard, or a network route of its own: the host asks the user, performs the operation
 * and hands back only data.
 */

// Files

/** File types a picker offers, as the extension declares them. */
export interface FileTypeFilter {
  readonly description: string;
  /** Extensions without the dot, such as `csv`. */
  readonly extensions: readonly string[];
}

/** What the host asks the user, in its own dialog, before opening a picker for an extension. */
export interface FileRequest {
  readonly extensionName: string;
  readonly kind: 'open' | 'save';
  /** The extension's stated reason, shown to the user, such as "Import a parts list". */
  readonly purpose: string;
  readonly accept: readonly FileTypeFilter[];
  readonly suggestedName?: string;
}

/**
 * The host's file pickers. Each first shows the host's own prompt naming the extension and its purpose; the user's
 * choice there is also the gesture browser pickers need. Both resolve to null when the user declines or cancels.
 */
export interface FilePicker {
  open(request: FileRequest): Promise<{ name: string; type: string; data: Uint8Array } | null>;
  save(request: FileRequest, data: Uint8Array): Promise<{ name: string } | null>;
}

export const FILE_LIMITS = { bytes: 64 * 1024 * 1024, purposeChars: 200, filters: 20 } as const;

function fileRequest(input: unknown, kind: FileRequest['kind'], extensionName: string): FileRequest {
  const fields = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const purpose = typeof fields.purpose === 'string' ? fields.purpose.trim() : '';
  if (!purpose || purpose.length > FILE_LIMITS.purposeChars)
    throw new ExtensionError('validation.failed', `files.${kind} needs a purpose of 1 to ${FILE_LIMITS.purposeChars} characters, shown to the user.`);
  const raw = Array.isArray(fields.accept) ? fields.accept : [];
  if (raw.length > FILE_LIMITS.filters) throw new ExtensionError('validation.failed', `At most ${FILE_LIMITS.filters} file types.`);
  const accept = raw.map((f): FileTypeFilter => {
    const filter = (typeof f === 'object' && f !== null ? f : {}) as Record<string, unknown>;
    const extensions = Array.isArray(filter.extensions) ? filter.extensions : [];
    if (typeof filter.description !== 'string' || !filter.description.trim() || filter.description.length > 100
      || extensions.length === 0 || !extensions.every((e) => typeof e === 'string' && /^[A-Za-z0-9]{1,16}$/.test(e)))
      throw new ExtensionError('validation.failed', 'Each file type needs a description and extensions such as "csv", without the dot.');
    return { description: filter.description.trim(), extensions: extensions as string[] };
  });
  const suggested = fields.suggestedName;
  // Control characters are refused along with path separators and characters file systems reserve.
  // eslint-disable-next-line no-control-regex
  if (suggested !== undefined && (typeof suggested !== 'string' || !/^[^/\\:*?"<>|\u0000-\u001f]{1,200}$/.test(suggested)))
    throw new ExtensionError('validation.failed', 'suggestedName must be a plain file name.');
  return { extensionName, kind, purpose, accept, ...(typeof suggested === 'string' ? { suggestedName: suggested } : {}) };
}

/**
 * `files.open({ purpose, accept })` → `{ name, type, data }` for one file the user chose, and
 * `files.save({ purpose, accept, suggestedName, data })` → `{ name }` once the user chose where. Declining answers
 * `cancelled`.
 */
export function fileServices(manifest: ExtensionManifest, picker: FilePicker): ServiceImplementations {
  return {
    'files.open': async (input) => {
      const chosen = await picker.open(fileRequest(input, 'open', manifest.name));
      if (!chosen) throw new ExtensionError('cancelled', 'No file was chosen.');
      if (chosen.data.byteLength > FILE_LIMITS.bytes) throw new ExtensionError('limit.exceeded', `The file is larger than ${FILE_LIMITS.bytes / 1024 / 1024} MiB.`);
      return { name: chosen.name, type: chosen.type, data: chosen.data };
    },
    'files.save': async (input) => {
      const data = (input as { data?: unknown } | null)?.data;
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : null;
      if (!bytes) throw new ExtensionError('validation.failed', 'files.save needs data as a string or a Uint8Array.');
      if (bytes.byteLength > FILE_LIMITS.bytes) throw new ExtensionError('limit.exceeded', `The file is larger than ${FILE_LIMITS.bytes / 1024 / 1024} MiB.`);
      const saved = await picker.save(fileRequest(input, 'save', manifest.name), bytes);
      if (!saved) throw new ExtensionError('cancelled', 'The file was not saved.');
      return { name: saved.name };
    },
  };
}

// Clipboard

export interface ClipboardWriter {
  write(items: { text?: string; html?: string; png?: Uint8Array }): Promise<void>;
}

export const CLIPBOARD_LIMITS = { textChars: 1024 * 1024, imageBytes: 16 * 1024 * 1024 } as const;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * `clipboard.write({ text?, html?, png? })` puts text, rich text and a PNG image on the clipboard, only soon after
 * the user acted on the extension. There is no way to read the clipboard.
 */
export function clipboardServices(writer: ClipboardWriter): ServiceImplementations {
  return {
    'clipboard.write': async (input, call: ServiceCall) => {
      if (!call.userActivated()) throw new ExtensionError('permission.denied', 'The clipboard can be written only right after the user acts on the extension.');
      const { text, html, png } = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
      const items: { text?: string; html?: string; png?: Uint8Array } = {};
      if (text !== undefined) {
        if (typeof text !== 'string' || text.length > CLIPBOARD_LIMITS.textChars) throw new ExtensionError('validation.failed', 'text must be a string of at most 1 Mi characters.');
        items.text = text;
      }
      if (html !== undefined) {
        if (typeof html !== 'string' || html.length > CLIPBOARD_LIMITS.textChars) throw new ExtensionError('validation.failed', 'html must be a string of at most 1 Mi characters.');
        items.html = html;
      }
      if (png !== undefined) {
        if (!(png instanceof Uint8Array) || png.byteLength > CLIPBOARD_LIMITS.imageBytes || !PNG.every((b, i) => png[i] === b))
          throw new ExtensionError('validation.failed', 'png must be PNG image bytes of at most 16 MiB.');
        items.png = png;
      }
      if (!Object.keys(items).length) throw new ExtensionError('validation.failed', 'clipboard.write needs text, html or png.');
      await writer.write(items);
      return null;
    },
  };
}

// Network

/** One brokered request as a transport performs it. The transport follows no redirects itself. */
export interface FetchTransportRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array | null;
  readonly signal: AbortSignal;
  /** The most response body bytes to read; the transport stops and reports `truncated` beyond it. */
  readonly maxResponseBytes: number;
}

export interface FetchTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly truncated?: boolean;
}

/** Performs requests outside the extension: the desktop shell, or a PushForm relay. */
export type FetchTransport = (request: FetchTransportRequest) => Promise<FetchTransportResponse>;

export const FETCH_LIMITS = {
  requestBytes: 1024 * 1024,
  responseBytes: 4 * 1024 * 1024,
  timeoutMs: 30_000,
  redirects: 5,
  /** Requests per extension per minute. */
  perMinute: 60,
} as const;

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
/** Headers an extension may not set: credentials and cookies of the host, and connection-level headers. */
const FORBIDDEN_REQUEST = /^(cookie|cookie2|host|origin|referer|connection|content-length|transfer-encoding|upgrade|proxy-.*|sec-.*|x-forwarded-.*|forwarded)$/i;
/** Response headers passed back; cookies and the rest are dropped. */
const ALLOWED_RESPONSE = new Set(['content-type', 'content-language', 'cache-control', 'etag', 'last-modified', 'expires', 'retry-after', 'location']);

/**
 * The network broker. A request goes only to an HTTPS destination the manifest declares and the user granted, under
 * the destination's path prefix, with no host cookie or credential and within size, rate and time limits. A
 * destination that receives model data also needs the model-egress grant. Redirects are followed here, not by the
 * transport, and each new location is checked like the first. The bytes sent to each destination are counted for
 * the extension manager.
 */
export class FetchBroker {
  private readonly destinations: { prefix: URL; sendsModelData: boolean }[];
  private readonly recent: number[] = [];
  /** Bytes sent per destination origin during this session. */
  readonly bytesSent = new Map<string, number>();

  constructor(
    manifest: ExtensionManifest,
    private readonly grants: ReadonlySet<ExtensionPermission>,
    private readonly transport: FetchTransport | null,
  ) {
    this.destinations = manifest.destinations.map((d) => ({ prefix: new URL(d.url), sendsModelData: d.sendsModelData }));
  }

  /** Whether `url` may be requested; throws a structured error naming why not. */
  check(url: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ExtensionError('validation.failed', 'The URL is not valid.');
    }
    if (parsed.protocol !== 'https:') throw new ExtensionError('permission.denied', 'Only https URLs can be requested.');
    if (parsed.username || parsed.password) throw new ExtensionError('permission.denied', 'URLs may not carry credentials.');
    const destination = this.destinations.find((d) => d.prefix.origin === parsed.origin
      && (parsed.pathname === d.prefix.pathname || parsed.pathname.startsWith(d.prefix.pathname.endsWith('/') ? d.prefix.pathname : `${d.prefix.pathname}/`)));
    if (!destination) throw new ExtensionError('permission.denied', `${parsed.origin}${parsed.pathname} is not a destination declared in the manifest.`);
    if (!this.grants.has('network')) throw new ExtensionError('permission.denied', 'Network access was not granted.', { permission: 'network' });
    if (destination.sendsModelData && !this.grants.has('model.egress'))
      throw new ExtensionError('permission.denied', `Sending model data to ${parsed.origin} was not granted.`, { permission: 'model.egress' });
    return parsed;
  }

  services(): ServiceImplementations {
    return {
      'http.fetch': async (input, call) => {
        const fields = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
        if (typeof fields.url !== 'string') throw new ExtensionError('validation.failed', 'http.fetch needs a url.');
        let url = this.check(fields.url);
        const method = typeof fields.method === 'string' ? fields.method.toUpperCase() : 'GET';
        if (!METHODS.has(method)) throw new ExtensionError('validation.failed', `The method ${method} is not supported.`);
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries((fields.headers ?? {}) as Record<string, unknown>)) {
          if (typeof value !== 'string' || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/.test(name) || value.length > 8192 || /[\r\n]/.test(value))
            throw new ExtensionError('validation.failed', `The header ${name} is not valid.`);
          if (FORBIDDEN_REQUEST.test(name)) throw new ExtensionError('permission.denied', `The header ${name} cannot be set by an extension.`);
          headers[name.toLowerCase()] = value;
        }
        const raw = fields.body;
        const body = raw === undefined || raw === null ? null : typeof raw === 'string' ? new TextEncoder().encode(raw) : raw instanceof Uint8Array ? raw : undefined;
        if (body === undefined) throw new ExtensionError('validation.failed', 'body must be a string or a Uint8Array.');
        if (body && body.byteLength > FETCH_LIMITS.requestBytes) throw new ExtensionError('limit.exceeded', 'The request body is larger than 1 MiB.');
        if (!this.transport) throw new ExtensionError('unavailable', 'Network requests from extensions are not available here yet.');
        const now = performance.now();
        while (this.recent.length && now - this.recent[0]! > 60_000) this.recent.shift();
        if (this.recent.length >= FETCH_LIMITS.perMinute) throw new ExtensionError('limit.exceeded', `At most ${FETCH_LIMITS.perMinute} requests a minute.`);
        this.recent.push(now);

        const signal = AbortSignal.any([call.signal, AbortSignal.timeout(FETCH_LIMITS.timeoutMs)]);
        let currentMethod = method;
        let currentBody = body;
        for (let hop = 0; ; hop++) {
          this.bytesSent.set(url.origin, (this.bytesSent.get(url.origin) ?? 0) + (currentBody?.byteLength ?? 0));
          let response: FetchTransportResponse;
          try {
            response = await this.transport({ url: url.href, method: currentMethod, headers, body: currentBody, signal, maxResponseBytes: FETCH_LIMITS.responseBytes });
          } catch {
            if (call.signal.aborted) throw new ExtensionError('cancelled', 'The request was cancelled.');
            if (signal.aborted) throw new ExtensionError('limit.exceeded', `The request took longer than ${FETCH_LIMITS.timeoutMs / 1000} s.`);
            throw new ExtensionError('unavailable', 'The request failed.');
          }
          const location = response.headers.location;
          if (response.status >= 300 && response.status < 400 && location) {
            if (hop >= FETCH_LIMITS.redirects) throw new ExtensionError('limit.exceeded', 'Too many redirects.');
            url = this.check(new URL(location, url).href);
            if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod === 'POST')) {
              currentMethod = 'GET';
              currentBody = null;
            }
            continue;
          }
          if (response.truncated || response.body.byteLength > FETCH_LIMITS.responseBytes)
            throw new ExtensionError('limit.exceeded', 'The response is larger than 4 MiB.');
          const kept: Record<string, string> = {};
          for (const [name, value] of Object.entries(response.headers)) if (ALLOWED_RESPONSE.has(name.toLowerCase())) kept[name.toLowerCase()] = value;
          return { status: response.status, url: url.href, headers: kept, body: response.body };
        }
      },
    };
  }
}
