import { createCloseupScene, disposeScene } from './common';
import { buildMetaphase, buildNucleosomes } from './chromosomesParts';
import { createJiggle } from './kit';
import type { CloseupFactory } from './types';

/**
 * Chromosomes close-up, two views:
 *  0 "metaphase" (1 unit = 10 nm): one condensed mitotic chromosome — two
 *    sister chromatids joined at a submetacentric centromere, kinetochore
 *    plates with their spindle microtubules, glowing telomeres.
 *  1 "nucleosomes" (1 unit = 1 nm): a short stretch of chromatin, DNA wrapped
 *    around histone octamers with linker DNA between them.
 */
const create: CloseupFactory = (ctx) => {
  const scene = createCloseupScene('#140c28');
  const time = { value: 0 };
  const jiggle = createJiggle(time);
  const builds = [
    buildMetaphase({ quality: ctx.quality, pointScale: ctx.pointScale, jiggle }),
    buildNucleosomes({ quality: ctx.quality, pointScale: ctx.pointScale, jiggle }),
  ];
  builds.forEach((b) => scene.add(b.group));
  let active = 0;
  const setView = (index: number) => {
    active = Math.max(0, Math.min(builds.length - 1, index));
    builds.forEach((b, i) => {
      b.group.visible = i === active;
    });
  };
  setView(0);
  return {
    scene,
    views: builds.map((b) => ({ target: b.target, radius: b.radius, direction: b.direction, labels: b.labels })),
    setView,
    update(_dt, t, calm) {
      time.value = t;
      jiggle.amount.value = calm ? 0.3 : 1;
      builds[active].update(t, calm);
    },
    dispose() {
      builds.forEach((b) => b.dispose());
      disposeScene(scene);
    },
  };
};

export default create;
