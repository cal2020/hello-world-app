import type { Claim, FactRecord, Quantity, StructureId } from './types';

/**
 * Scientific claims for each structure. Numbers live here, once, and are
 * formatted per language; the prose for labels and measurement context lives
 * in the locale files under structures.<id>.
 *
 * `pending: true` marks a claim whose support could not be verified during
 * the build (see docs/VERIFICATION.md); the interface labels it.
 */
export interface ScienceRecord {
  typicalSize: Claim;
  typicalQuantity: Claim;
  descriptionSources: string[];
  functionSources: string[];
  facts: FactRecord[];
  interesting: Claim;
  textValues?: Record<string, Quantity>;
}

const q = (value: number, unit: Quantity['unit'], extra: Partial<Quantity> = {}): Quantity => ({ value, unit, ...extra });
const range = (min: number, max: number, unit: Quantity['unit'], extra: Partial<Quantity> = {}): Quantity => ({ min, max, unit, ...extra });
const about = { approx: true } as const;

export const SCIENCE: Record<StructureId, ScienceRecord> = {
  'plasma-membrane': {
    descriptionSources: ['cooper-2000-plasma-membrane', 'alberts-2002-lipid-bilayer', 'alberts-2002-membrane-proteins'],
    functionSources: ['cooper-2000-plasma-membrane', 'alberts-2002-membrane-proteins'],
    typicalSize: { value: q(5, 'nm', about), sources: ['bionumbers-101835'] },
    typicalQuantity: { value: q(1e9, 'molecules', about), sources: ['alberts-2002-lipid-bilayer'] },
    facts: [
      { id: 'lipid-density', value: q(5e6, 'perUm2', about), sources: ['alberts-2002-lipid-bilayer'] },
      {
        id: 'protein-share',
        value: q(50, 'percentMass', about),
        values: { myelin: q(25, 'percent', { qualifier: 'under' }), inner: q(75, 'percent', about) },
        sources: ['alberts-2002-membrane-proteins'],
      },
      { id: 'lipids-per-protein', value: q(50, 'count', about), sources: ['alberts-2002-membrane-proteins'] },
      { id: 'cholesterol', value: q(1, 'ratio', about), sources: ['cooper-2000-plasma-membrane'] },
      {
        id: 'small-share',
        value: q(25, 'times', about),
        values: { pancreas: q(12, 'times', about) },
        sources: ['bionumbers-110374'],
      },
    ],
    interesting: {
      values: { swaps: q(1e7, 'timesPerSecond', about), distance: q(2, 'um', about), time: q(1, 'seconds', about) },
      sources: ['alberts-2002-lipid-bilayer'],
    },
    textValues: { patch: q(40, 'nm') },
  },
  cytoplasm: {
    descriptionSources: ['mboc4-internal-organization', 'alberts-2002-table-12-1'],
    functionSources: ['mboc4-internal-organization', 'mboc4-from-rna-to-protein'],
    typicalSize: { value: q(54, 'percentVolume', about), sources: ['alberts-2002-table-12-1'] },
    typicalQuantity: { value: q(200, 'gPerL', about), sources: ['bionumbers-113237', 'bionumbers-113238'] },
    facts: [
      { id: 'mito-share', value: q(22, 'percentVolume', about), sources: ['alberts-2002-table-12-1'] },
      {
        id: 'er-share',
        value: q(9, 'percentVolume', about),
        values: { smooth: q(6, 'percent', about) },
        sources: ['alberts-2002-table-12-1'],
      },
      { id: 'small-share', value: q(1, 'percentVolume', about), sources: ['alberts-2002-table-12-1'] },
      { id: 'ph', value: q(7.2, 'pH', about), sources: ['cooper-2000-lysosomes'] },
    ],
    interesting: { sources: ['bionumbers-110373'] },
    textValues: { cube: q(100, 'nm') },
  },
  nucleus: {
    descriptionSources: ['alberts-2002-chromosomal-dna', 'cremer-2010'],
    functionSources: ['alberts-2002-chromosomal-dna', 'beck-hurt-2017'],
    typicalSize: {
      value: q(6, 'percentVolume', about),
      values: { range: range(5, 10, 'percent') },
      sources: ['alberts-2002-table-12-1', 'bionumbers-104262'],
    },
    typicalQuantity: {
      value: q(6.37, 'Gb', about),
      values: { male: q(6.27, 'Gb', about) },
      sources: ['piovesan-2019'],
    },
    facts: [
      {
        id: 'dna-length',
        value: q(2.08, 'm', about),
        values: { male: q(2.05, 'm', about) },
        sources: ['piovesan-2019', 'bionumbers-104208'],
      },
      { id: 'dna-mass', value: q(6.51, 'pg', about), sources: ['piovesan-2019'] },
      { id: 'pore-size', value: q(120, 'nm', about), sources: ['beck-hurt-2017'], pending: true },
      { id: 'pore-traffic', value: q(1000, 'perSecond', about), sources: ['ribbeck-gorlich-2001'], pending: true },
      { id: 'territories', sources: ['cremer-2010'] },
    ],
    interesting: {
      values: { length: q(2, 'm', about), share: q(6, 'percent', about) },
      sources: ['piovesan-2019', 'alberts-2002-table-12-1'],
    },
    textValues: { poreSize: q(120, 'nm') },
  },
  chromosomes: {
    descriptionSources: ['alberts-2002-chromosomal-dna', 'medlineplus-chromosomes'],
    functionSources: ['alberts-2002-chromosomal-dna', 'cremer-2010'],
    typicalSize: { value: q(2.08, 'm', about), sources: ['piovesan-2019', 'bionumbers-104208'] },
    typicalQuantity: {
      value: q(46, 'chromosomes'),
      values: { pairs: q(23, 'none'), autosomePairs: q(22, 'none') },
      sources: ['medlineplus-chromosomes'],
    },
    facts: [
      {
        id: 'genome-size',
        value: q(3.055, 'Gb', about),
        values: { older: q(3.2, 'Gb', about) },
        sources: ['nurk-2022', 'alberts-2002-chromosomal-dna'],
      },
      {
        id: 'diploid-content',
        value: q(6.37, 'Gb', about),
        values: { male: q(6.27, 'Gb', about) },
        sources: ['piovesan-2019'],
      },
      { id: 'kinds', value: q(24, 'count'), sources: ['alberts-2002-chromosomal-dna', 'medlineplus-chromosomes'] },
      { id: 'x-inactivation', sources: ['embryo-project-lyon-1961'] },
      {
        id: 'nucleosome',
        value: q(146, 'bp'),
        values: { turns: q(1.65, 'none') },
        sources: ['luger-1997'],
        pending: true,
      },
    ],
    interesting: { sources: ['barr-bertram-1949', 'embryo-project-lyon-1961'] },
    textValues: {
      chromosomeCount: q(46, 'none'),
      pairCount: q(23, 'none'),
      dnaWidth: q(2, 'nm'),
      nucleosomeWidth: q(11, 'nm'),
    },
  },
  telomeres: {
    descriptionSources: ['moyzis-1988', 'de-lange-2005'],
    functionSources: ['de-lange-2005', 'griffith-1999', 'harley-1990', 'greider-blackburn-1985'],
    typicalSize: { value: range(5, 15, 'kb', about), sources: ['aubert-lansdorp-2008'], pending: true },
    typicalQuantity: { value: q(92, 'count'), values: { chromosomes: q(46, 'none') }, sources: ['medlineplus-chromosomes'] },
    facts: [
      { id: 'repeat', value: q(6, 'bp'), sources: ['moyzis-1988'], pending: true },
      { id: 'shelterin', value: q(6, 'proteins'), sources: ['de-lange-2005'], pending: true },
      { id: 'shortening', value: q(50, 'bpPerDivision', about), sources: ['harley-1990'], pending: true },
      { id: 't-loop', sources: ['griffith-1999'], pending: true },
      { id: 'telomerase', sources: ['greider-blackburn-1985'], pending: true },
    ],
    interesting: { sources: ['nurk-2022'] },
    textValues: { telomereCount: q(92, 'none') },
  },
  nucleolus: {
    descriptionSources: ['boisvert-2007'],
    functionSources: ['boisvert-2007', 'lewis-tollervey-2000'],
    typicalSize: { sources: ['boisvert-2007'], pending: true },
    typicalQuantity: { value: q(10, 'chromosomes'), sources: ['boisvert-2007', 'nurk-2022'], pending: true },
    facts: [
      { id: 'production', value: q(7500, 'perMinute', about), sources: ['lewis-tollervey-2000'], pending: true },
      { id: 'layers', value: q(3, 'count'), sources: ['boisvert-2007'], pending: true },
      { id: 'liquid', sources: ['feric-2016'], pending: true },
      { id: 'firre', sources: ['yang-2015-firre'] },
    ],
    interesting: { sources: ['barr-bertram-1949'] },
    textValues: { norPairs: q(5, 'none') },
  },
  ribosomes: {
    descriptionSources: ['mboc4-from-rna-to-protein', 'khatter-2015', 'anger-2013'],
    functionSources: ['mboc4-from-rna-to-protein', 'nissen-2000', 'ingolia-2011'],
    typicalSize: { value: range(25, 30, 'nm', about), sources: ['bionumbers-100483'] },
    typicalQuantity: { value: q(9.5e6, 'perCell', about), sources: ['bionumbers-107347'] },
    facts: [
      { id: 'mass', value: q(4.3, 'MDa', about), sources: ['khatter-2015'] },
      {
        id: 'parts',
        value: q(80, 'proteins', about),
        values: { rnas: q(4, 'none'), large: q(47, 'none'), small: q(33, 'none') },
        sources: ['khatter-2015'],
      },
      { id: 'speed', value: q(5.6, 'aaPerSecond', about), sources: ['ingolia-2011', 'bionumbers-107952'] },
      { id: 'modifications', value: q(130, 'count', { qualifier: 'over' }), sources: ['natchiar-2017'] },
      { id: 'polysomes', sources: ['mboc4-from-rna-to-protein'] },
    ],
    interesting: { values: { distance: q(1.8, 'nm', about) }, sources: ['nissen-2000'] },
    textValues: { size: range(25, 30, 'nm') },
  },
  'rough-er': {
    descriptionSources: ['mboc4-endoplasmic-reticulum', 'cooper-2000-endoplasmic-reticulum'],
    functionSources: ['mboc4-endoplasmic-reticulum', 'cooper-2000-endoplasmic-reticulum', 'shibata-2010'],
    typicalSize: { value: q(50, 'nm', about), values: { yeast: q(30, 'nm', about) }, sources: ['shibata-2010'] },
    typicalQuantity: { value: q(9, 'percentVolume', about), sources: ['alberts-2002-table-12-1'] },
    facts: [
      {
        id: 'membrane-share',
        value: q(50, 'percentMembrane', about),
        sources: ['mboc4-endoplasmic-reticulum', 'cooper-2000-endoplasmic-reticulum'],
      },
      { id: 'lumen-volume', value: q(10, 'percentVolume', about), sources: ['cooper-2000-endoplasmic-reticulum'] },
      {
        id: 'rough-membrane',
        value: q(35, 'percentMembrane', about),
        values: { pancreas: q(60, 'percent', about) },
        sources: ['bionumbers-110374'],
      },
      { id: 'spacer', sources: ['shibata-2010'] },
    ],
    interesting: { sources: ['terasaki-2013'] },
  },
  'smooth-er': {
    descriptionSources: ['mboc4-endoplasmic-reticulum', 'cooper-2000-endoplasmic-reticulum'],
    functionSources: ['mboc4-endoplasmic-reticulum', 'cooper-2000-endoplasmic-reticulum', 'bionumbers-112892'],
    typicalSize: { value: range(30, 50, 'nm'), sources: ['hu-2011'], pending: true },
    typicalQuantity: { value: q(6, 'percentVolume', about), sources: ['alberts-2002-table-12-1'] },
    facts: [
      {
        id: 'calcium',
        value: range(60, 500, 'uM'),
        values: { cytosol: q(100, 'nMolar', about) },
        sources: ['bionumbers-112892', 'bionumbers-107490'],
      },
      { id: 'scarce', sources: ['mboc4-endoplasmic-reticulum'] },
      { id: 'steroids', sources: ['mboc4-endoplasmic-reticulum', 'cooper-2000-endoplasmic-reticulum'] },
      {
        id: 'phenobarbital',
        value: q(100, 'percentIncrease'),
        values: { area: q(90, 'percent', about), days: q(5, 'days') },
        sources: ['bolender-weibel-1973'],
      },
      { id: 'exit-sites', sources: ['mboc4-endoplasmic-reticulum'] },
    ],
    interesting: { values: { days: q(5, 'days', about) }, sources: ['bolender-weibel-1973'] },
    textValues: { tubeWidth: range(30, 50, 'nm') },
  },
  golgi: {
    descriptionSources: ['mboc4-golgi-transport', 'cooper-2000-golgi-em', 'munro-2011'],
    functionSources: ['mboc4-golgi-transport', 'cooper-2000-golgi-regions', 'munro-2011'],
    typicalSize: { value: range(0.5, 1, 'um', about), sources: ['mboc4-golgi-transport'], pending: true },
    typicalQuantity: { value: q(6, 'percentVolume', about), sources: ['alberts-2002-table-12-1'] },
    facts: [
      { id: 'ergic', sources: ['cooper-2000-golgi-regions'] },
      { id: 'sorting', sources: ['cooper-2000-golgi-regions'] },
      { id: 'glycans', sources: ['mboc4-golgi-transport', 'munro-2011'] },
      {
        id: 'residence',
        value: q(42, 'minutes', about),
        values: { rate: q(3, 'percent', about) },
        sources: ['hirschberg-1998', 'bionumbers-112596'],
      },
      { id: 'tac', value: q(16, 'minutes', about), values: { long: q(3.4, 'hours', about) }, sources: ['tie-2025'] },
    ],
    interesting: { sources: ['mazzarello-bentivoglio-1998', 'munro-2011'] },
  },
  'vesicles-motors': {
    descriptionSources: ['mboc4-membrane-transport', 'mboc4-golgi-transport'],
    functionSources: ['mboc4-golgi-transport', 'hirschberg-1998', 'svoboda-1993'],
    typicalSize: { value: q(100, 'nm', about), sources: ['traub-2011'] },
    typicalQuantity: { value: q(10000, 'molecules', { qualifier: 'upTo' }), sources: ['hirschberg-1998'] },
    facts: [
      { id: 'step', value: q(8, 'nm'), sources: ['svoboda-1993'] },
      { id: 'atp', value: q(1, 'count'), values: { step: q(8, 'nm') }, sources: ['schnitzer-block-1997'], pending: true },
      { id: 'head-step', value: q(16, 'nm', about), sources: ['yildiz-2004'], pending: true },
      {
        id: 'rates',
        value: range(2.8, 3, 'percentPerMinute'),
        sources: ['hirschberg-1998', 'bionumbers-112596'],
      },
      { id: 'lifetime', value: q(3.8, 'minutes', about), sources: ['bionumbers-112598', 'hirschberg-1998'] },
    ],
    interesting: { sources: ['hirschberg-1998'] },
    textValues: { headStep: q(16, 'nm'), step: q(8, 'nm') },
  },
  mitochondria: {
    descriptionSources: ['mboc4-book', 'alberts-2002-table-12-1'],
    functionSources: ['mboc4-book', 'noji-1997', 'watt-2010'],
    typicalSize: { value: range(0.5, 1, 'um', about), sources: ['mboc4-book'], pending: true },
    typicalQuantity: { value: q(1665, 'perCell', about), sources: ['bionumbers-105783'] },
    facts: [
      { id: 'volume', value: q(22, 'percentVolume', about), sources: ['alberts-2002-table-12-1', 'bionumbers-105782'] },
      {
        id: 'inner-membrane',
        value: q(32, 'percentMembrane', about),
        values: { rough: q(35, 'percent', about) },
        sources: ['bionumbers-110374'],
      },
      {
        id: 'mtdna',
        value: q(16569, 'bp'),
        values: { proteins: q(13, 'none'), trnas: q(22, 'none'), rrnas: q(2, 'none') },
        sources: ['anderson-1981'],
        pending: true,
      },
      { id: 'atp-per-turn', value: q(3, 'atpPerTurn'), sources: ['noji-1997', 'watt-2010'], pending: true },
      {
        id: 'protons',
        value: q(2.7, 'protonsPerAtp', about),
        values: { csub: q(8, 'none') },
        sources: ['watt-2010'],
        pending: true,
      },
    ],
    interesting: {
      values: { mito: q(22, 'percent', about), nucleus: q(6, 'percent', about), rough: q(9, 'percent', about) },
      sources: ['alberts-2002-table-12-1'],
    },
    textValues: { atp: q(3, 'none') },
  },
  lysosomes: {
    descriptionSources: ['cooper-2000-lysosomes', 'xu-ren-2015'],
    functionSources: ['xu-ren-2015', 'cooper-2000-lysosomes', 'mindell-2012'],
    typicalSize: { value: range(0.1, 1.2, 'um'), values: { typical: q(0.5, 'um', about) }, sources: ['bionumbers-106072'] },
    typicalQuantity: {
      value: range(50, 1000, 'perCell'),
      values: { low: q(50, 'none') },
      sources: ['bionumbers-107483', 'bionumbers-117094'],
    },
    facts: [
      { id: 'ph', value: range(4.5, 5, 'pH'), sources: ['mindell-2012'] },
      {
        id: 'enzymes',
        value: q(60, 'enzymes', { qualifier: 'over' }),
        values: { older: q(50, 'none', about) },
        sources: ['xu-ren-2015', 'cooper-2000-lysosomes'],
      },
      { id: 'membrane-proteins', value: q(50, 'proteins', { qualifier: 'over' }), sources: ['xu-ren-2015'] },
      { id: 'volume', value: q(1, 'percentVolume', about), sources: ['alberts-2002-table-12-1'] },
      {
        id: 'diseases',
        value: q(70, 'diseases', { qualifier: 'over' }),
        values: { births: q(5000, 'none') },
        sources: ['platt-2018'],
      },
    ],
    interesting: { sources: ['nobel-de-duve'] },
  },
  endosomes: {
    descriptionSources: ['mboc4-endocytosis', 'huotari-helenius-2011'],
    functionSources: ['huotari-helenius-2011', 'henne-2011', 'goldstein-brown-2009'],
    typicalSize: { values: { vesicle: q(100, 'nm', about) }, sources: ['traub-2011'] },
    typicalQuantity: { value: q(1, 'percentVolume', about), sources: ['alberts-2002-table-12-1'] },
    facts: [
      { id: 'early-ph', value: range(6.1, 6.8, 'pH'), sources: ['huotari-helenius-2011'] },
      {
        id: 'late-ph',
        value: range(4.8, 6, 'pH'),
        values: { lysosome: q(4.5, 'pH', about) },
        sources: ['huotari-helenius-2011'],
      },
      {
        id: 'ldl-receptor',
        value: q(10, 'minutes', about),
        values: { life: q(20, 'hours', about) },
        sources: ['brown-goldstein-1985', 'goldstein-brown-2009'],
      },
      { id: 'mvb', sources: ['henne-2011', 'huotari-helenius-2011'] },
      { id: 'maturation', sources: ['huotari-helenius-2011'] },
    ],
    interesting: {
      values: {
        macrophage: q(3, 'percent', about),
        whole: q(33, 'minutes', about),
        lcell: q(0.8, 'percent', about),
        lwhole: q(2, 'hours', about),
      },
      sources: ['steinman-1976'],
    },
  },
  peroxisomes: {
    descriptionSources: ['cooper-2000-peroxisomes', 'mboc4-peroxisomes'],
    functionSources: ['wanders-waterham-2006', 'cooper-2000-peroxisomes', 'mboc4-peroxisomes'],
    typicalSize: { value: range(0.1, 1, 'um', about), sources: ['cooper-2000-peroxisomes'], pending: true },
    typicalQuantity: { value: q(1, 'percentVolume', about), sources: ['alberts-2002-table-12-1'] },
    facts: [
      { id: 'catalase-role', sources: ['cooper-2000-peroxisomes', 'mboc4-peroxisomes'] },
      { id: 'fatty-acids', sources: ['cooper-2000-peroxisomes', 'wanders-waterham-2006'] },
      { id: 'plasmalogens', sources: ['mboc4-peroxisomes', 'wanders-waterham-2006'] },
      { id: 'pts1', value: q(3, 'count'), sources: ['gould-1989'] },
      { id: 'urate-oxidase', sources: ['wu-1992', 'usuda-1988'] },
    ],
    interesting: { sources: ['pdb101-catalase'] },
  },
  microtubules: {
    descriptionSources: ['mboc4-cytoskeleton'],
    functionSources: ['mboc4-cytoskeleton', 'mitchison-kirschner-1984'],
    typicalSize: { value: q(25, 'nm', about), sources: ['mboc4-cytoskeleton'], pending: true },
    typicalQuantity: { value: q(13, 'protofilaments'), sources: ['mboc4-cytoskeleton'], pending: true },
    facts: [
      { id: 'dimer', value: q(8, 'nm', about), sources: ['mboc4-cytoskeleton'], pending: true },
      { id: 'instability', sources: ['mitchison-kirschner-1984'], pending: true },
      { id: 'gtp-cap', sources: ['mboc4-cytoskeleton'], pending: true },
      { id: 'anchoring', sources: ['mboc4-cytoskeleton', 'bornens-2012'], pending: true },
    ],
    interesting: { sources: ['mitchison-kirschner-1984'], pending: true },
    textValues: { protofilaments: q(13, 'none'), dimerLength: q(8, 'nm') },
  },
  actin: {
    descriptionSources: ['mboc4-cytoskeleton', 'pollard-cooper-2009'],
    functionSources: ['pollard-cooper-2009', 'pollard-1986', 'mullins-1998'],
    typicalSize: { value: range(5, 9, 'nm'), sources: ['mboc4-cytoskeleton'], pending: true },
    typicalQuantity: { sources: ['pollard-cooper-2009'], pending: true },
    facts: [
      {
        id: 'barbed-rate',
        value: q(11.6, 'rateConstant'),
        values: { pointed: q(1.3, 'rateConstant') },
        sources: ['pollard-1986'],
        pending: true,
      },
      { id: 'branch-angle', value: q(70, 'degrees', about), sources: ['mullins-1998'], pending: true },
      { id: 'treadmilling', sources: ['pollard-cooper-2009'], pending: true },
      { id: 'cortex', sources: ['mboc4-cytoskeleton', 'pollard-cooper-2009'], pending: true },
    ],
    interesting: { sources: ['pollard-cooper-2009'], pending: true },
    textValues: { branchAngle: q(70, 'degrees'), width: range(5, 9, 'nm') },
  },
  'intermediate-filaments': {
    descriptionSources: ['mboc4-cytoskeleton', 'herrmann-aebi-2016'],
    functionSources: ['herrmann-aebi-2016', 'kreplak-2005'],
    typicalSize: { value: q(10, 'nm', about), sources: ['mboc4-cytoskeleton', 'herrmann-aebi-2016'], pending: true },
    typicalQuantity: { value: q(70, 'genes', about), sources: ['szeverenyi-2008'], pending: true },
    facts: [
      { id: 'ulf', value: q(60, 'nm', about), values: { tetramers: q(8, 'none') }, sources: ['herrmann-aebi-2016'], pending: true },
      { id: 'no-polarity', sources: ['mboc4-cytoskeleton'], pending: true },
      { id: 'lamins', sources: ['herrmann-aebi-2016'], pending: true },
      { id: 'types', sources: ['herrmann-aebi-2016', 'szeverenyi-2008'], pending: true },
    ],
    interesting: { sources: ['kreplak-2005'], pending: true },
    textValues: { width: q(10, 'nm') },
  },
  centrosome: {
    descriptionSources: ['nigg-raff-2009', 'bornens-2012'],
    functionSources: ['nigg-raff-2009', 'bornens-2012', 'mboc4-cytoskeleton'],
    typicalSize: {
      value: range(0.2, 0.25, 'um', about),
      values: { length: range(0.4, 0.5, 'um', about) },
      sources: ['nigg-raff-2009', 'bornens-2012'],
      pending: true,
    },
    typicalQuantity: { value: q(2, 'count'), sources: ['nigg-raff-2009'], pending: true },
    facts: [
      { id: 'triplets', value: q(9, 'count'), sources: ['nigg-raff-2009'], pending: true },
      { id: 'duplication', sources: ['nigg-raff-2009'], pending: true },
      { id: 'nucleation', sources: ['bornens-2012', 'mboc4-cytoskeleton'], pending: true },
      { id: 'cilium', sources: ['nigg-raff-2009'], pending: true },
    ],
    interesting: { sources: ['nigg-raff-2009'], pending: true },
  },
};

/** Model dimensions used in overview/about prose (not biological claims). */
export const MODEL_TEXT_VALUES: Record<string, Quantity> = {
  cellWidth: q(14, 'um'),
  nucleusWidth: q(6, 'um'),
};
