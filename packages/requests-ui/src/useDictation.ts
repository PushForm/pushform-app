// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef, useState } from 'react';

/** The parts of the Web Speech API's recognizer the composer uses. */
interface Recognizer {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognizerConstructor = new () => Recognizer;

const recognizerConstructor = (): RecognizerConstructor | null => {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: RecognizerConstructor; webkitSpeechRecognition?: RecognizerConstructor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

export interface Dictation {
  /** False where the platform has no speech recognizer; the button stays visible but disabled. */
  readonly supported: boolean;
  readonly listening: boolean;
  /** Why the last session stopped early, in words for the requester; null when it ended normally. */
  readonly error: string | null;
  readonly toggle: () => void;
  readonly stop: () => void;
}

/** Speech to text for the composer: each finished phrase is handed to `onText`, which appends it to the draft. */
export function useDictation(onText: (text: string) => void): Dictation {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognizer = useRef<Recognizer | null>(null);
  const deliver = useRef(onText); deliver.current = onText;
  const Constructor = recognizerConstructor();

  const stop = (): void => { recognizer.current?.stop(); };
  const start = (): void => {
    if (!Constructor) return;
    const r = new Constructor();
    r.continuous = true;
    r.interimResults = false;
    r.lang = typeof navigator !== 'undefined' ? navigator.language : 'en-US';
    r.onresult = event => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const phrase = result?.[0]?.transcript.trim();
        if (result?.isFinal && phrase) deliver.current(phrase);
      }
    };
    r.onerror = event => {
      if (event.error === 'aborted' || event.error === 'no-speech') return;
      setError(event.error === 'not-allowed' || event.error === 'service-not-allowed'
        ? 'Dictation needs permission to use the microphone.'
        : 'Dictation stopped unexpectedly. Please try again.');
    };
    r.onend = () => { if (recognizer.current === r) { recognizer.current = null; setListening(false); } };
    recognizer.current = r;
    setError(null);
    try { r.start(); setListening(true); } catch { recognizer.current = null; setError('Dictation could not start. Please try again.'); }
  };
  const toggle = (): void => { if (recognizer.current) stop(); else start(); };

  useEffect(() => () => { const r = recognizer.current; recognizer.current = null; r?.abort(); }, []);
  return { supported: Constructor !== null, listening, error, toggle, stop };
}
