import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { TriMesh, weldMesh } from './mesh';

export interface LoadedModel {
  mesh: TriMesh;
  name: string;
  /** Unit guess for the file format: glTF is metres by spec; others unknown. */
  unitsGuess: 'mm' | 'cm' | 'm' | 'in';
}

function soupFromObject3D(root: THREE.Object3D): Float64Array {
  root.updateMatrixWorld(true);
  const chunks: number[] = [];
  const v = new THREE.Vector3();
  root.traverse((obj) => {
    const m = obj as THREE.Mesh;
    if (!m.isMesh) return;
    const geom = m.geometry as THREE.BufferGeometry;
    const pos = geom.getAttribute('position');
    if (!pos) return;
    const index = geom.getIndex();
    const count = index ? index.count : pos.count;
    for (let i = 0; i < count; i++) {
      const vi = index ? index.getX(i) : i;
      v.fromBufferAttribute(pos as THREE.BufferAttribute, vi).applyMatrix4(m.matrixWorld);
      chunks.push(v.x, v.y, v.z);
    }
  });
  return Float64Array.from(chunks);
}

export async function loadModelFile(file: File): Promise<LoadedModel> {
  const name = file.name;
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'stl') {
    const buf = await file.arrayBuffer();
    const geom = new STLLoader().parse(buf);
    const mesh = new THREE.Mesh(geom);
    return { mesh: weldMesh(soupFromObject3D(mesh)), name, unitsGuess: 'mm' };
  }
  if (ext === 'obj') {
    const text = await file.text();
    const obj = new OBJLoader().parse(text);
    return { mesh: weldMesh(soupFromObject3D(obj)), name, unitsGuess: 'mm' };
  }
  if (ext === 'ply') {
    const buf = await file.arrayBuffer();
    const geom = new PLYLoader().parse(buf);
    return { mesh: weldMesh(soupFromObject3D(new THREE.Mesh(geom))), name, unitsGuess: 'mm' };
  }
  if (ext === 'gltf' || ext === 'glb') {
    const buf = await file.arrayBuffer();
    const gltf = await new Promise<any>((resolve, reject) => new GLTFLoader().parse(buf, '', resolve, reject));
    return { mesh: weldMesh(soupFromObject3D(gltf.scene)), name, unitsGuess: 'm' };
  }
  throw new Error(`Unsupported file type .${ext}. Use STL, OBJ, PLY, GLTF or GLB.`);
}
