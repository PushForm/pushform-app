// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import defaultKeymapJson from './defaultKeymap.json';

export type Platform = 'mac' | 'win' | 'linux';

export interface KeyBinding {
  /** Normalized chord, e.g. `Ctrl+Shift+Z`, `Space`, `Meta+Z`. */
  readonly key: string;
  readonly command: string;
}

export interface KeymapJson {
  readonly default: readonly KeyBinding[];
  readonly mac?: readonly KeyBinding[];
  readonly win?: readonly KeyBinding[];
  readonly linux?: readonly KeyBinding[];
  /** Extra bindings when running in a browser (browser differences). */
  readonly web?: readonly KeyBinding[];
}

/** The subset of KeyboardEvent the keymap reads (so tests need no DOM). */
export interface KeyEventLike {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

export function detectPlatform(): Platform {
  const nav = (globalThis as { navigator?: { platform?: string; userAgent?: string } }).navigator;
  const p = `${nav?.platform ?? ''} ${nav?.userAgent ?? ''}`.toLowerCase();
  if (p.includes('mac')) return 'mac';
  if (p.includes('win')) return 'win';
  return 'linux';
}

const MOD_ORDER = ['Ctrl', 'Meta', 'Alt', 'Shift'] as const;

/** Normalize a chord string: resolves `Mod`, orders modifiers, upper-cases single letters. */
export function normalizeChord(chord: string, platform: Platform): string {
  const parts = chord.split('+').map((p) => p.trim()).filter(Boolean);
  const mods = new Set<string>();
  let main = '';
  for (const part of parts) {
    const low = part.toLowerCase();
    if (low === 'mod') mods.add(platform === 'mac' ? 'Meta' : 'Ctrl');
    else if (low === 'ctrl' || low === 'control') mods.add('Ctrl');
    else if (low === 'cmd' || low === 'meta' || low === 'command') mods.add('Meta');
    else if (low === 'alt' || low === 'option') mods.add('Alt');
    else if (low === 'shift') mods.add('Shift');
    else main = normalizeMainKey(part);
  }
  const ordered = MOD_ORDER.filter((m) => mods.has(m));
  return [...ordered, main].filter(Boolean).join('+');
}

function normalizeMainKey(k: string): string {
  if (k.length === 1) return k.toUpperCase();
  const low = k.toLowerCase();
  switch (low) {
    case ' ':
    case 'space':
    case 'spacebar':
      return 'Space';
    case 'esc':
    case 'escape':
      return 'Escape';
    case 'del':
    case 'delete':
      return 'Delete';
    case 'enter':
    case 'return':
      return 'Enter';
    case 'arrowup':
    case 'up':
      return 'ArrowUp';
    case 'arrowdown':
    case 'down':
      return 'ArrowDown';
    case 'arrowleft':
    case 'left':
      return 'ArrowLeft';
    case 'arrowright':
    case 'right':
      return 'ArrowRight';
    default:
      return k.charAt(0).toUpperCase() + k.slice(1);
  }
}

/** Build the normalized chord for a keyboard event (uses `code` for letters/digits so layouts/Shift don't matter). */
export function chordFromEvent(e: KeyEventLike): string {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.metaKey) mods.push('Meta');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  let main: string;
  const letter = e.code.match(/^Key([A-Z])$/);
  const digit = e.code.match(/^Digit(\d)$/);
  if (letter) main = letter[1]!;
  else if (digit) main = digit[1]!;
  else if (e.code === 'Space' || e.key === ' ') main = 'Space';
  else if (e.key.length === 1) main = e.key.toUpperCase();
  else main = normalizeMainKey(e.key);
  return [...mods, main].join('+');
}

export class Keymap {
  private byChord = new Map<string, string>();
  private byCommand = new Map<string, string[]>();

  constructor(
    readonly platform: Platform = detectPlatform(),
    json: KeymapJson = defaultKeymapJson as KeymapJson,
    readonly isWeb = false,
  ) {
    this.load(json);
  }

  load(json: KeymapJson): void {
    this.byChord.clear();
    this.byCommand.clear();
    const sections: (readonly KeyBinding[])[] = [json.default, json[this.platform] ?? []];
    if (this.isWeb && json.web) sections.push(json.web);
    for (const section of sections) for (const b of section) this.bind(b.key, b.command);
  }

  bind(chord: string, command: string): void {
    const norm = normalizeChord(chord, this.platform);
    const prev = this.byChord.get(norm);
    if (prev) {
      const list = this.byCommand.get(prev);
      if (list) this.byCommand.set(prev, list.filter((c) => c !== norm));
    }
    this.byChord.set(norm, command);
    const list = this.byCommand.get(command) ?? [];
    list.push(norm);
    this.byCommand.set(command, list);
  }

  unbind(chord: string): void {
    const norm = normalizeChord(chord, this.platform);
    const cmd = this.byChord.get(norm);
    if (!cmd) return;
    this.byChord.delete(norm);
    this.byCommand.set(cmd, (this.byCommand.get(cmd) ?? []).filter((c) => c !== norm));
  }

  /** Resolve a keyboard event to a command id, or null. */
  resolve(e: KeyEventLike): string | null {
    return this.byChord.get(chordFromEvent(e)) ?? null;
  }

  /** All chords bound to a command (normalized). */
  bindingsFor(command: string): readonly string[] {
    return this.byCommand.get(command) ?? [];
  }

  /** Human-readable label for the first binding of a command (`⌘⇧Z` on mac, `Ctrl+Shift+Z` elsewhere). */
  label(command: string): string | null {
    const chord = this.bindingsFor(command)[0];
    return chord ? formatChord(chord, this.platform) : null;
  }

  entries(): readonly KeyBinding[] {
    return [...this.byChord].map(([key, command]) => ({ key, command }));
  }
}

export function formatChord(chord: string, platform: Platform): string {
  const parts = chord.split('+');
  if (platform === 'mac') {
    const sym: Record<string, string> = { Ctrl: '⌃', Meta: '⌘', Alt: '⌥', Shift: '⇧' };
    return parts.map((p) => sym[p] ?? p).join('');
  }
  return parts.join('+');
}
