// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef, useState } from 'react';
import { MaterialStudio } from '@pushform/render';
import type { Material } from '@pushform/model';

export function MaterialPreview({
  material,
  textureUrl,
  normalUrl,
}: {
  material: Material;
  textureUrl?: string | undefined;
  normalUrl?: string | undefined;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    studio = useRef<MaterialStudio | null>(null);
  const [status, setStatus] = useState('Loading preview');
  useEffect(() => {
    const element = canvas.current;
    if (!element || typeof WebGL2RenderingContext === 'undefined') {
      setStatus('Preview unavailable');
      return;
    }
    let observer: ResizeObserver | undefined;
    const contextLost = () => setStatus('Preview unavailable');
    element.addEventListener('webglcontextlost', contextLost);
    try {
      const preview = new MaterialStudio(element, setStatus);
      studio.current = preview;
      observer = new ResizeObserver(() => preview.resize(element.clientWidth));
      observer.observe(element);
      preview.resize(element.clientWidth);
    } catch {
      setStatus('Preview unavailable');
    }
    return () => {
      element.removeEventListener('webglcontextlost', contextLost);
      observer?.disconnect();
      studio.current?.dispose();
      studio.current = null;
    };
  }, []);
  useEffect(() => {
    studio.current?.setMaterial(material, textureUrl, normalUrl);
  }, [material, textureUrl, normalUrl]);
  return (
    <div className="pf-material-preview">
      <canvas
        ref={canvas}
        aria-label="Studio material sample"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            e.stopPropagation();
            studio.current?.rotate(e.key === 'ArrowLeft' ? -1 : 1);
          }
          if (e.key === 'Home') {
            e.preventDefault();
            e.stopPropagation();
            studio.current?.reset();
          }
        }}
      />
      <div className="pf-material-preview-bar">
        <strong>Studio preview</strong>
        <button className="pf-btn" onClick={() => studio.current?.reset()}>
          Reset view
        </button>
      </div>
      {status && (
        <p className="pf-form-note" role="status">
          {status}
        </p>
      )}
      <p className="pf-form-note">
        Neutral studio for comparing finishes. Your model uses its own environment.
      </p>
    </div>
  );
}
