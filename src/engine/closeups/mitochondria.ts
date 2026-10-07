import * as THREE from 'three';
import { createCloseupScene, disposeScene } from './common';
import { createJiggle } from './kit';
import { buildOrganelleView } from './mitochondriaOrganelle';
import { buildSynthaseView } from './mitochondriaSynthase';
import type { CloseupFactory } from './types';

/**
 * Mitochondria close-up, two views:
 * 0 "organelle" (1 unit = 10 nm): a mitochondrion cut open lengthwise.
 * 1 "atp-synthase" (1 unit = 1 nm): a patch of crista membrane with the
 *   electron transport chain pumping protons and ATP synthase turning.
 */
const create: CloseupFactory = (ctx) => {
  const scene = createCloseupScene('#1a0b17');
  const time = { value: 0 };
  const jiggle = createJiggle(time);
  const organelle = buildOrganelleView(ctx.quality, jiggle, time);
  const synthase = buildSynthaseView(ctx.quality, jiggle, ctx.pointScale);
  scene.add(organelle.group, synthase.group);
  let current = 0;
  let calmNow = false;
  const show = (index: number) => {
    current = index;
    organelle.group.visible = index === 0;
    synthase.group.visible = index === 1;
    if (index === 0) organelle.update(time.value, calmNow);
    else synthase.update(time.value, calmNow);
  };
  show(0);

  return {
    scene,
    views: [
      {
        target: new THREE.Vector3(0, -1.5, -8),
        radius: 102,
        direction: new THREE.Vector3(0.3, 0.42, 1).normalize(),
        labels: organelle.labels,
      },
      {
        target: new THREE.Vector3(2.5, -1.5, -3),
        radius: 37,
        direction: new THREE.Vector3(0.16, 0.3, 1).normalize(),
        labels: synthase.labels,
      },
    ],
    setView(index) {
      show(index);
    },
    update(_dt, t, calm) {
      time.value = t;
      calmNow = calm;
      jiggle.amount.value = calm ? 0.3 : 1;
      if (current === 0) organelle.update(t, calm);
      else synthase.update(t, calm);
    },
    dispose() {
      organelle.dispose();
      synthase.dispose();
      disposeScene(scene);
    },
  };
};

export default create;
