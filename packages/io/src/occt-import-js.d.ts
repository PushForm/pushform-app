// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors

// The parts of occt-import-js (OpenCascade compiled to wasm, LGPL-2.1) the STEP reader uses; the package ships no types.
declare module 'occt-import-js' {
  export interface OcctBrepFace { first: number; last: number; color: [number, number, number] | null }
  export interface OcctMesh {
    name: string;
    color?: [number, number, number];
    brep_faces: OcctBrepFace[];
    attributes: { position: { array: number[] }; normal?: { array: number[] } };
    index: { array: number[] };
  }
  export interface OcctNode { name: string; meshes: number[]; children: OcctNode[] }
  export interface OcctResult { success: boolean; root: OcctNode; meshes: OcctMesh[] }
  export interface OcctParams {
    linearUnit?: 'millimeter' | 'centimeter' | 'meter' | 'inch' | 'foot';
    linearDeflectionType?: 'bounding_box_ratio' | 'absolute_value';
    linearDeflection?: number;
    angularDeflection?: number;
  }
  export interface OcctModule { ReadStepFile(content: Uint8Array, params: OcctParams | null): OcctResult }
  const init: (options?: { wasmBinary?: Uint8Array }) => Promise<OcctModule>;
  export default init;
}

// Vite's `?url` imports: the bundled file's URL.
declare module '*?url' {
  const url: string;
  export default url;
}
