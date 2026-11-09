// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import {
  ACESFilmicToneMapping,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  PMREMGenerator,
  Scene,
  WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { PreviewMesh, PreviewView } from '@pushform/cloud/preview';

/** Only validated display data enters this viewer: no native files or external resources. */
export function createMaterialPreview(mesh: PreviewMesh) {
  const renderer = new WebGLRenderer({ antialias: true, alpha: true });
  const scene = new Scene(),
    geometry = new BufferGeometry(),
    materials: MeshStandardMaterial[] = [];
  let environment: ReturnType<PMREMGenerator['fromScene']> | undefined;
  try {
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    const room = new RoomEnvironment(),
      pmrem = new PMREMGenerator(renderer);
    try {
      environment = pmrem.fromScene(room);
    } finally {
      room.dispose();
      pmrem.dispose();
    }
    scene.environment = environment.texture;
    scene.add(new HemisphereLight(0xffffff, 0x888888, 0.8));
    const key = new DirectionalLight(0xffffff, 2.5);
    key.position.set(-2, -3, 5);
    scene.add(key);
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(mesh.positions), 3));
    if (mesh.normals)
      geometry.setAttribute(
        'normal',
        new BufferAttribute(new Float32Array(mesh.normals.map((n) => n / 127)), 3),
      );
    else geometry.computeVertexNormals();
    const colors = new Float32Array(mesh.positions.length),
      color = new Color();
    const groups = new Map<number, number[]>();
    for (let t = 0; t < mesh.positions.length / 9; t++) {
      color.setRGB(
        mesh.colors?.[t * 3] ?? 0.596,
        mesh.colors?.[t * 3 + 1] ?? 0.714,
        mesh.colors?.[t * 3 + 2] ?? 0.659,
        'srgb',
      );
      for (let v = 0; v < 3; v++) color.toArray(colors, t * 9 + v * 3);
      const id = mesh.finishIds?.[t] ?? 0;
      let indices = groups.get(id);
      if (!indices) {
        indices = [];
        groups.set(id, indices);
      }
      indices.push(t * 3, t * 3 + 1, t * 3 + 2);
    }
    geometry.setAttribute('color', new BufferAttribute(colors, 3));
    const indices: number[] = [];
    for (const [id, triangles] of groups) {
      const f = mesh.finishes?.[id] ?? [0.8, 0, 1, 0, 0, 0, 0];
      const material = new MeshStandardMaterial({
        vertexColors: true,
        side: DoubleSide,
        roughness: f[0],
        metalness: f[1],
        opacity: f[2],
        transparent: f[2]! < 1,
        emissive: new Color().setRGB(f[3]!, f[4]!, f[5]!, 'srgb'),
        emissiveIntensity: f[6],
      });
      geometry.addGroup(indices.length, triangles.length, materials.length);
      indices.push(...triangles);
      materials.push(material);
    }
    geometry.setIndex(indices);
    scene.add(new Mesh(geometry, materials));
  } catch (error) {
    geometry.dispose();
    materials.forEach((m) => m.dispose());
    environment?.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    throw error;
  }
  const camera = new OrthographicCamera();
  camera.up.set(0, 0, 1);
  return {
    available: () => !renderer.getContext().isContextLost(),
    render(view: PreviewView, width: number, height: number) {
      renderer.setSize(width, height, false);
      const half = 0.75 / view.zoom;
      camera.left = (-half * width) / height;
      camera.right = (half * width) / height;
      camera.top = half;
      camera.bottom = -half;
      camera.near = 0.01;
      camera.far = 10;
      camera.position.set(
        -Math.sin(view.yaw) * Math.cos(view.pitch) * 3,
        -Math.cos(view.yaw) * Math.cos(view.pitch) * 3,
        Math.sin(view.pitch) * 3,
      );
      camera.lookAt(0, 0, 0);
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
      return renderer.domElement;
    },
    dispose() {
      geometry.dispose();
      materials.forEach((m) => m.dispose());
      environment?.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
