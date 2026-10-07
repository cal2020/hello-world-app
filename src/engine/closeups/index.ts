import type { StructureId } from '../../content/types';
import type { CloseupFactory } from './types';

type Loader = () => Promise<{ default: CloseupFactory }>;

/**
 * Close-up scenes are separate chunks, downloaded only when a close-up is
 * opened (they are not needed for the whole-cell view).
 */
export const CLOSEUP_LOADERS: Record<StructureId, Loader> = {
  'plasma-membrane': () => import('./plasmaMembrane'),
  cytoplasm: () => import('./cytoplasm'),
  nucleus: () => import('./nucleus'),
  chromosomes: () => import('./chromosomes'),
  telomeres: () => import('./telomeres'),
  nucleolus: () => import('./nucleolus'),
  ribosomes: () => import('./ribosomes'),
  'rough-er': () => import('./roughEr'),
  'smooth-er': () => import('./smoothEr'),
  golgi: () => import('./golgi'),
  'vesicles-motors': () => import('./vesiclesMotors'),
  mitochondria: () => import('./mitochondria'),
  lysosomes: () => import('./lysosomes'),
  endosomes: () => import('./endosomes'),
  peroxisomes: () => import('./peroxisomes'),
  microtubules: () => import('./microtubules'),
  actin: () => import('./actin'),
  'intermediate-filaments': () => import('./intermediateFilaments'),
  centrosome: () => import('./centrosome'),
};
