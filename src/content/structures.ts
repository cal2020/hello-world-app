import type { CloseupInfo, GroupId, ModelScale, Relation, StructureId } from './types';

/**
 * Structural (non-numeric-fact) metadata for the 19 structures: routing,
 * grouping, illustrative colour, labelled parts, relationships, how each one
 * is represented in the whole-cell model, and its close-up views.
 *
 * The array order is the navigation order (list, previous/next and tour).
 */
export interface StructureMeta {
  id: StructureId;
  slug: string;
  group: GroupId;
  color: string;
  parts: string[];
  related: Relation[];
  model: ModelScale;
  closeup: CloseupInfo;
}

export const STRUCTURE_META: StructureMeta[] = [
  // ── Cell boundary and interior ───────────────────────────────────────────
  {
    id: 'plasma-membrane',
    slug: 'plasma-membrane',
    group: 'boundary',
    color: '#6e9bff',
    parts: ['bilayer', 'phospholipid', 'cholesterol', 'channel', 'receptor', 'glycocalyx'],
    related: [
      { id: 'cytoplasm', kind: 'encloses' },
      { id: 'actin', kind: 'supportedBy' },
      { id: 'endosomes', kind: 'sendsTo' },
      { id: 'vesicles-motors', kind: 'fusesWith' },
    ],
    model: {
      dimension: 'thickness',
      biologicalNm: { min: 5, max: 10 },
      renderedNm: 80,
      enlargement: 10,
      drawn: null,
    },
    closeup: { views: [{ id: 'bilayer', unitNm: 1, moleculeEnlargement: 1, slowdown: null }] },
  },
  {
    id: 'cytoplasm',
    slug: 'cytoplasm',
    group: 'boundary',
    color: '#6a8ca8',
    parts: ['cytosol', 'enzyme', 'free-ribosome', 'mrna', 'filament'],
    related: [
      { id: 'plasma-membrane', kind: 'enclosedBy' },
      { id: 'ribosomes', kind: 'contains' },
      { id: 'mitochondria', kind: 'contains' },
      { id: 'microtubules', kind: 'contains' },
    ],
    model: {
      dimension: 'diameter',
      biologicalNm: null,
      renderedNm: 30,
      enlargement: null,
      drawn: null,
    },
    closeup: { views: [{ id: 'crowding', unitNm: 1, moleculeEnlargement: 1, slowdown: null }] },
  },
  // ── Genetic material and nuclear structures ──────────────────────────────
  {
    id: 'nucleus',
    slug: 'nucleus',
    group: 'genetic',
    color: '#9f86ff',
    parts: ['outer-membrane', 'inner-membrane', 'perinuclear-space', 'pore-complex', 'lamina', 'import', 'export'],
    related: [
      { id: 'chromosomes', kind: 'contains' },
      { id: 'nucleolus', kind: 'contains' },
      { id: 'rough-er', kind: 'continuousWith' },
      { id: 'intermediate-filaments', kind: 'supportedBy' },
    ],
    model: {
      dimension: 'diameter',
      biologicalNm: { min: 5000, max: 10000 },
      renderedNm: 6000,
      enlargement: 1,
      drawn: { low: 1, medium: 1, high: 1 },
    },
    closeup: { views: [{ id: 'pore', unitNm: 1, moleculeEnlargement: 1, slowdown: null }] },
  },
  {
    id: 'chromosomes',
    slug: 'chromosomes',
    group: 'genetic',
    color: '#f06bc8',
    parts: ['territory', 'inactive-x', 'chromatid', 'centromere', 'kinetochore', 'chromosome-end', 'nucleosome', 'dna'],
    related: [
      { id: 'nucleus', kind: 'partOf' },
      { id: 'telomeres', kind: 'contains' },
      { id: 'nucleolus', kind: 'makes' },
      { id: 'centrosome', kind: 'worksWith' },
    ],
    model: {
      dimension: 'width',
      biologicalNm: { min: 10, max: 30 },
      renderedNm: 70,
      enlargement: 3,
      drawn: { low: 46, medium: 46, high: 46 },
    },
    closeup: {
      views: [
        { id: 'metaphase', unitNm: 10, moleculeEnlargement: 1, slowdown: null },
        { id: 'nucleosomes', unitNm: 1, moleculeEnlargement: 1, slowdown: null },
      ],
    },
  },
  {
    id: 'telomeres',
    slug: 'telomeres',
    group: 'genetic',
    color: '#fff07a',
    parts: ['repeats', 'overhang', 't-loop', 'shelterin', 'chromosome-end'],
    related: [
      { id: 'chromosomes', kind: 'partOf' },
      { id: 'nucleus', kind: 'enclosedBy' },
    ],
    model: {
      dimension: 'diameter',
      biologicalNm: null,
      renderedNm: 110,
      enlargement: null,
      drawn: { low: 92, medium: 92, high: 92 },
    },
    closeup: { views: [{ id: 't-loop', unitNm: 1, moleculeEnlargement: 1, slowdown: null }] },
  },
  {
    id: 'nucleolus',
    slug: 'nucleolus',
    group: 'genetic',
    color: '#ff7a45',
    parts: ['fibrillar-center', 'dense-fibrillar', 'granular', 'rdna', 'small-subunit', 'large-subunit'],
    related: [
      { id: 'nucleus', kind: 'partOf' },
      { id: 'ribosomes', kind: 'makes' },
      { id: 'chromosomes', kind: 'formsOn' },
    ],
    model: {
      dimension: 'diameter',
      biologicalNm: { min: 500, max: 3000 },
      renderedNm: 1700,
      enlargement: 1,
      drawn: { low: 2, medium: 2, high: 2 },
    },
    closeup: { views: [{ id: 'assembly', unitNm: 10, moleculeEnlargement: 3, slowdown: null }] },
  },
  // ── Protein production and transport ─────────────────────────────────────
  {
    id: 'ribosomes',
    slug: 'ribosomes',
    group: 'protein',
    color: '#ffc23d',
    parts: ['large-subunit', 'small-subunit', 'mrna', 'trna', 'polypeptide', 'exit-tunnel'],
    related: [
      { id: 'nucleolus', kind: 'madeIn' },
      { id: 'rough-er', kind: 'attachesTo' },
      { id: 'cytoplasm', kind: 'partOf' },
    ],
    model: {
      dimension: 'diameter',
      biologicalNm: { min: 25, max: 30 },
      renderedNm: 70,
      enlargement: 2.5,
      drawn: { low: 1500, medium: 3000, high: 6000 },
    },
    closeup: { views: [{ id: 'translation', unitNm: 1, moleculeEnlargement: 1, slowdown: 10 }] },
  },
  {
    id: 'rough-er',
    slug: 'rough-endoplasmic-reticulum',
    group: 'protein',
    color: '#22d3c5',
    parts: ['er-sheet', 'lumen', 'bound-ribosome', 'translocon', 'signal-peptide', 'glycan', 'exit-site'],
    related: [
      { id: 'nucleus', kind: 'continuousWith' },
      { id: 'smooth-er', kind: 'continuousWith' },
      { id: 'ribosomes', kind: 'studdedWith' },
      { id: 'golgi', kind: 'sendsTo' },
    ],
    model: {
      dimension: 'thickness',
      biologicalNm: { min: 30, max: 60 },
      renderedNm: 60,
      enlargement: 1,
      drawn: null,
    },
    closeup: { views: [{ id: 'translocation', unitNm: 1, moleculeEnlargement: 1, slowdown: null }] },
  },
  {
    id: 'smooth-er',
    slug: 'smooth-endoplasmic-reticulum',
    group: 'protein',
    color: '#6ee7a0',
    parts: ['tubule', 'junction', 'calcium-pump', 'calcium-channel', 'lipid-enzyme'],
    related: [
      { id: 'rough-er', kind: 'continuousWith' },
      { id: 'mitochondria', kind: 'worksWith' },
      { id: 'peroxisomes', kind: 'worksWith' },
    ],
    model: {
      dimension: 'diameter',
      biologicalNm: { min: 30, max: 50 },
      renderedNm: 80,
      enlargement: 2,
      drawn: null,
    },
    closeup: { views: [{ id: 'calcium', unitNm: 1, moleculeEnlargement: 1, slowdown: null }] },
  },
  {
    id: 'golgi',
    slug: 'golgi-apparatus',
    group: 'protein',
    color: '#ff9e3d',
    parts: ['cis', 'medial', 'trans', 'tgn', 'copii', 'copi', 'secretory-vesicle'],
    related: [
      { id: 'rough-er', kind: 'receivesFrom' },
      { id: 'vesicles-motors', kind: 'sendsTo' },
      { id: 'lysosomes', kind: 'sendsTo' },
      { id: 'centrosome', kind: 'worksWith' },
    ],
    model: {
      dimension: 'diameter',
      biologicalNm: { min: 500, max: 1500 },
      renderedNm: 1200,
      enlargement: 1,
      drawn: { low: 3, medium: 3, high: 3 },
    },
    closeup: { views: [{ id: 'stack', unitNm: 10, moleculeEnlargement: 1, slowdown: null }] },
  },
  {
    id: 'vesicles-motors',
    slug: 'vesicles-and-motor-proteins',
    group: 'protein',
    color: '#ff6f91',
    parts: ['vesicle', 'kinesin', 'motor-heads', 'neck-linker', 'stalk', 'dynein', 'track', 'plus-end'],
    related: [
      { id: 'microtubules', kind: 'travelsAlong' },
      { id: 'golgi', kind: 'receivesFrom' },
      { id: 'plasma-membrane', kind: 'fusesWith' },
      { id: 'endosomes', kind: 'worksWith' },
    ],
    model: {
      dimension: 'diameter',
      biologicalNm: { min: 100, max: 100 },
      renderedNm: 110,
      enlargement: 1,
      drawn: { low: 60, medium: 120, high: 200 },
    },
    closeup: { views: [{ id: 'kinesin', unitNm: 1, moleculeEnlargement: 1, slowdown: 50 }] },
  },
  // ── Energy, digestion, and chemical processing ───────────────────────────
  {
    id: 'mitochondria',
    slug: 'mitochondria',
    group: 'energy',
    color: '#ff5a5f',
    parts: ['outer-membrane', 'inner-membrane', 'intermembrane-space', 'cristae', 'matrix', 'mtdna', 'etc', 'atp-synthase', 'protons'],
    related: [
      { id: 'cytoplasm', kind: 'suppliesEnergyTo' },
      { id: 'microtubules', kind: 'travelsAlong' },
      { id: 'smooth-er', kind: 'worksWith' },
      { id: 'peroxisomes', kind: 'worksWith' },
    ],
    model: {
      dimension: 'diameter',
      biologicalNm: { min: 500, max: 1000 },
      renderedNm: 500,
      enlargement: 1,
      drawn: { low: 30, medium: 45, high: 60 },
    },
    closeup: {
      views: [
        { id: 'organelle', unitNm: 10, moleculeEnlargement: 1, slowdown: null },
        { id: 'atp-synthase', unitNm: 1, moleculeEnlargement: 1, slowdown: 100 },
      ],
    },
  },
  {
    id: 'lysosomes',
    slug: 'lysosomes',
    group: 'energy',
    color: '#c77dff',
    parts: ['membrane', 'lumen', 'v-atpase', 'hydrolase', 'membrane-glycans', 'transporter'],
    related: [
      { id: 'endosomes', kind: 'fusesWith' },
      { id: 'golgi', kind: 'receivesFrom' },
      { id: 'cytoplasm', kind: 'partOf' },
    ],
    model: {
      dimension: 'diameter',
      biologicalNm: { min: 100, max: 1200 },
      renderedNm: 450,
      enlargement: 1,
      drawn: { low: 18, medium: 24, high: 30 },
    },
    closeup: { views: [{ id: 'digestion', unitNm: 1, moleculeEnlargement: 1, slowdown: null }] },
  },
  {
    id: 'endosomes',
    slug: 'endosomes',
    group: 'energy',
    color: '#4cc9f0',
    parts: ['coated-pit', 'early-endosome', 'recycling-tubule', 'late-endosome', 'intraluminal-vesicle', 'receptor', 'cargo'],
    related: [
      { id: 'plasma-membrane', kind: 'receivesFrom' },
      { id: 'lysosomes', kind: 'sendsTo' },
      { id: 'vesicles-motors', kind: 'worksWith' },
      { id: 'actin', kind: 'worksWith' },
    ],
    model: {
      dimension: 'diameter',
      biologicalNm: { min: 100, max: 500 },
      renderedNm: 400,
      enlargement: 1,
      drawn: { low: 14, medium: 20, high: 26 },
    },
    closeup: { views: [{ id: 'sorting', unitNm: 1, moleculeEnlargement: 1, slowdown: null }] },
  },
  {
    id: 'peroxisomes',
    slug: 'peroxisomes',
    group: 'energy',
    color: '#b5e853',
    parts: ['membrane', 'matrix', 'catalase', 'oxidase', 'import-receptor', 'fatty-acid'],
    related: [
      { id: 'mitochondria', kind: 'worksWith' },
      { id: 'smooth-er', kind: 'worksWith' },
      { id: 'cytoplasm', kind: 'partOf' },
    ],
    model: {
      dimension: 'diameter',
      biologicalNm: { min: 100, max: 1000 },
      renderedNm: 350,
      enlargement: 1,
      drawn: { low: 16, medium: 22, high: 28 },
    },
    closeup: { views: [{ id: 'reactions', unitNm: 1, moleculeEnlargement: 1, slowdown: null }] },
  },
  // ── Structural support and movement ──────────────────────────────────────
  {
    id: 'microtubules',
    slug: 'microtubules',
    group: 'support',
    color: '#9bd4ff',
    parts: ['protofilament', 'tubulin-dimer', 'plus-end', 'minus-end', 'gtp-cap'],
    related: [
      { id: 'centrosome', kind: 'organizedBy' },
      { id: 'vesicles-motors', kind: 'supports' },
      { id: 'mitochondria', kind: 'supports' },
    ],
    model: {
      dimension: 'diameter',
      biologicalNm: { min: 25, max: 25 },
      renderedNm: 60,
      enlargement: 2.4,
      drawn: { low: 70, medium: 110, high: 160 },
    },
    closeup: { views: [{ id: 'dynamics', unitNm: 1, moleculeEnlargement: 1, slowdown: null }] },
  },
  {
    id: 'actin',
    slug: 'actin-filaments',
    group: 'support',
    color: '#ff9f9f',
    parts: ['filament', 'barbed-end', 'pointed-end', 'arp23', 'cortex', 'subunit'],
    related: [
      { id: 'plasma-membrane', kind: 'supports' },
      { id: 'endosomes', kind: 'worksWith' },
      { id: 'intermediate-filaments', kind: 'worksWith' },
    ],
    model: {
      dimension: 'diameter',
      biologicalNm: { min: 7, max: 7 },
      renderedNm: 30,
      enlargement: 4,
      drawn: { low: 900, medium: 1600, high: 2600 },
    },
    closeup: { views: [{ id: 'treadmilling', unitNm: 1, moleculeEnlargement: 1, slowdown: null }] },
  },
  {
    id: 'intermediate-filaments',
    slug: 'intermediate-filaments',
    group: 'support',
    color: '#e8dfa0',
    parts: ['filament', 'dimer', 'tetramer', 'ulf', 'perinuclear-cage'],
    related: [
      { id: 'nucleus', kind: 'supports' },
      { id: 'actin', kind: 'worksWith' },
      { id: 'microtubules', kind: 'worksWith' },
    ],
    model: {
      dimension: 'diameter',
      biologicalNm: { min: 10, max: 10 },
      renderedNm: 40,
      enlargement: 4,
      drawn: { low: 40, medium: 60, high: 80 },
    },
    closeup: { views: [{ id: 'assembly', unitNm: 1, moleculeEnlargement: 1, slowdown: null }] },
  },
  {
    id: 'centrosome',
    slug: 'centrosome',
    group: 'support',
    color: '#d9ccff',
    parts: ['mother-centriole', 'daughter-centriole', 'triplets', 'pcm', 'gamma-turc', 'appendages'],
    related: [
      { id: 'microtubules', kind: 'organizes' },
      { id: 'golgi', kind: 'worksWith' },
      { id: 'chromosomes', kind: 'worksWith' },
    ],
    model: {
      dimension: 'diameter',
      biologicalNm: { min: 200, max: 250 },
      renderedNm: 230,
      enlargement: 1,
      drawn: { low: 1, medium: 1, high: 1 },
    },
    closeup: { views: [{ id: 'centrioles', unitNm: 10, moleculeEnlargement: 1, slowdown: null }] },
  },
];
