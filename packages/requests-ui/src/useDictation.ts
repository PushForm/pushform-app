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
  const pending = useRef<object | null>(null);
  const deliver = useRef(onText); deliver.current = onText;
  const Constructor = recognizerConstructor();

  const stop = (): void => {
    pending.current = null;
    setListening(false);
    recognizer.current?.stop();
  };
  const start = async (): Promise<void> => {
    if (!Constructor) return;
    const request = {};
    pending.current = request;
    setError(null);
    setListening(true);
    // Request capture explicitly: speech-service startup can fail before prompting.
    if (navigator.mediaDevices?.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // Recognition owns its capture; this stream is only the permission request.
        stream.getTracks().forEach(track => track.stop());
      } catch (cause) {
        if (pending.current !== request) return;
        pending.current = null;
        setListening(false);
        const name = typeof cause === 'object' && cause !== null && 'name' in cause ? cause.name : '';
        setError(name === 'NotAllowedError' || name === 'SecurityError'
          ? 'Microphone access was blocked. Check your browser’s site settings and system microphone privacy settings, then try again.'
          : 'The microphone could not be opened. Check that it is connected and available, then try again.');
        return;
      }
    }
    if (pending.current !== request) return;
    pending.current = null;
    const r = new Constructor();
    r.continuous = true;
    r.interimResults = false;
    r.lang = typeof navigator !== 'undefined' ? navigator.language : 'en-US';
    r.onresult = event => {
      if (recognizer.current !== r) return;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const phrase = result?.[0]?.transcript.trim();
        if (result?.isFinal && phrase) deliver.current(phrase);
      }
    };
    r.onerror = event => {
      if (recognizer.current !== r) return;
      if (event.error === 'aborted' || event.error === 'no-speech') return;
      setError(event.error === 'service-not-allowed'
        ? 'Speech recognition is unavailable or blocked by this browser. You can still type your message.'
        : event.error === 'not-allowed'
          ? 'The browser blocked speech recognition. Check your browser and system privacy settings, then try again.'
          : 'Dictation stopped unexpectedly. Please try again.');
    };
    r.onend = () => { if (recognizer.current === r) { recognizer.current = null; setListening(false); } };
    recognizer.current = r;
    setError(null);
    try { r.start(); setListening(true); } catch { recognizer.current = null; setListening(false); setError('Dictation could not start. Please try again.'); }
  };
  const toggle = (): void => { if (pending.current || recognizer.current) stop(); else void start(); };

  useEffect(() => () => { pending.current = null; const r = recognizer.current; recognizer.current = null; r?.abort(); }, []);
  return { supported: Constructor !== null, listening, error, toggle, stop };
}
