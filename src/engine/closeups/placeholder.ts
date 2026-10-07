import * as THREE from 'three';
import { blobGeometry, createCloseupScene, disposeScene, material } from './common';
import type { CloseupFactory } from './types';

/** Temporary close-up used while a structure's dedicated scene is being built. */
const create: CloseupFactory = () => {
  const scene = createCloseupScene();
  const mesh = new THREE.Mesh(blobGeometry(10, 'placeholder'), material('#8fb8ff'));
  scene.add(mesh);
  return {
    scene,
    views: [{ target: new THREE.Vector3(), radius: 14, direction: new THREE.Vector3(0, 0.2, 1).normalize(), labels: [] }],
    setView() {},
    update(dt) {
      mesh.rotation.y += dt * 0.2;
    },
    dispose() {
      disposeScene(scene);
    },
  };
};

export default create;
