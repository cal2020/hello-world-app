import type { StructureId } from '../../content/types';
import type { CloseupFactory } from './types';

type Loader = () => Promise<{ default: CloseupFactory }>;

/**
 * Close-up scenes are separate chunks, downloaded only when a close-up is
 * opened (they are not needed for the whole-cell view).
 */
export const CLOSEUP_LOADERS: Record<StructureId, Loader> = {
  'plasma-membrane': () => import('./placeholder'),
  cytoplasm: () => import('./placeholder'),
  nucleus: () => import('./placeholder'),
  chromosomes: () => import('./placeholder'),
  telomeres: () => import('./placeholder'),
  nucleolus: () => import('./placeholder'),
  ribosomes: () => import('./placeholder'),
  'rough-er': () => import('./placeholder'),
  'smooth-er': () => import('./placeholder'),
  golgi: () => import('./placeholder'),
  'vesicles-motors': () => import('./placeholder'),
  mitochondria: () => import('./placeholder'),
  lysosomes: () => import('./placeholder'),
  endosomes: () => import('./placeholder'),
  peroxisomes: () => import('./placeholder'),
  microtubules: () => import('./placeholder'),
  actin: () => import('./placeholder'),
  'intermediate-filaments': () => import('./placeholder'),
  centrosome: () => import('./placeholder'),
};
