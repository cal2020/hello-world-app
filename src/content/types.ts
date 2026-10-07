/**
 * Language-neutral scientific content model.
 *
 * Everything that must stay identical across languages — identifiers,
 * routes, numbers, units, source references, relationships and rendering
 * metadata — lives in TypeScript records typed here. Locale files only hold
 * translatable prose keyed by the same identifiers, so language versions
 * cannot drift apart numerically.
 */

export const STRUCTURE_IDS = [
  'plasma-membrane',
  'cytoplasm',
  'nucleus',
  'chromosomes',
  'telomeres',
  'nucleolus',
  'ribosomes',
  'rough-er',
  'smooth-er',
  'golgi',
  'vesicles-motors',
  'mitochondria',
  'lysosomes',
  'endosomes',
  'peroxisomes',
  'microtubules',
  'actin',
  'intermediate-filaments',
  'centrosome',
] as const;

export type StructureId = (typeof STRUCTURE_IDS)[number];

export const GROUP_IDS = ['boundary', 'genetic', 'protein', 'energy', 'support'] as const;
export type GroupId = (typeof GROUP_IDS)[number];

/** Units understood by the formatter. Display symbols are localised. */
export type Unit =
  | 'nm'
  | 'um'
  | 'mm'
  | 'm'
  | 'pg'
  | 'bp'
  | 'kb'
  | 'Gb'
  | 'MDa'
  | 'pH'
  | 'percent'
  | 'percentVolume'
  | 'percentMembrane'
  | 'percentMass'
  | 'percentIncrease'
  | 'percentPerMinute'
  | 'perCell'
  | 'perUm2'
  | 'perSecond'
  | 'perMinute'
  | 'timesPerSecond'
  | 'aaPerSecond'
  | 'bpPerDivision'
  | 'rateConstant'
  | 'minutes'
  | 'hours'
  | 'seconds'
  | 'days'
  | 'degrees'
  | 'uM'
  | 'nMolar'
  | 'gPerL'
  | 'molecules'
  | 'proteins'
  | 'genes'
  | 'chromosomes'
  | 'enzymes'
  | 'diseases'
  | 'protofilaments'
  | 'ratio'
  | 'times'
  | 'protonsPerAtp'
  | 'atpPerTurn'
  | 'count'
  | 'none';

/**
 * A measured or modelled quantity. Either `value` or `min`/`max` is given.
 * `approx` renders a localised "about" marker.
 */
export interface Quantity {
  value?: number;
  min?: number;
  max?: number;
  unit: Unit;
  approx?: boolean;
  /** Prefix such as "more than" / "up to" (localised via ui.qualifier.*). */
  qualifier?: 'over' | 'upTo' | 'under';
}

export type SourceType = 'book-section' | 'article' | 'review' | 'web' | 'database' | 'table';

export interface SourceRecord {
  id: string;
  type: SourceType;
  /** Title in the publication's own language (not translated). */
  title: string;
  /** Authors in "Surname AB" form, or empty when an organisation is the author. */
  authors?: string;
  organization?: string;
  year?: number;
  /** Journal/book and locator, e.g. "Nature 365:721–727". */
  container?: string;
  url: string;
  doi?: string;
  /**
   * 'verified': the URL, title and supporting text were confirmed through
   * search-index records during the build. 'pending': a well-known citation
   * recorded from the author's knowledge that could not be checked in the
   * build environment (see docs/VERIFICATION.md).
   */
  status: 'verified' | 'pending';
  /** How the record was verified, or why it is pending (kept for auditing). */
  note: string;
}

/** A claim shown to readers. `pending` marks claims whose support is not yet verified. */
export interface Claim {
  value?: Quantity;
  /** Extra values interpolated into the claim's label/context ({name} placeholders). */
  values?: Record<string, Quantity>;
  sources: string[];
  pending?: boolean;
}

export interface FactRecord extends Claim {
  /** Locale key: structures.<id>.facts.<factId>.{label,context} */
  id: string;
}

export type RelationKind =
  | 'partOf'
  | 'contains'
  | 'enclosedBy'
  | 'continuousWith'
  | 'attachesTo'
  | 'receivesFrom'
  | 'sendsTo'
  | 'travelsAlong'
  | 'organizes'
  | 'organizedBy'
  | 'fusesWith'
  | 'supports'
  | 'supportedBy'
  | 'suppliesEnergyTo'
  | 'madeIn'
  | 'formsOn'
  | 'encloses'
  | 'studdedWith'
  | 'makes'
  | 'protects'
  | 'anchors'
  | 'worksWith';

export interface Relation {
  id: StructureId;
  kind: RelationKind;
}

/**
 * How a structure is represented in the whole-cell scene. Biological size,
 * rendered size, enlargement and sampling are stored separately on purpose.
 */
export interface ModelScale {
  /** What the size refers to (diameter, thickness, width…), localised via ui.dimension.*. */
  dimension: 'diameter' | 'thickness' | 'width' | 'length';
  /**
   * Typical biological size of one object in nm, or null when the drawn
   * object is a symbolic marker (e.g. a telomere is a length of DNA, not a
   * particle with a fixed diameter).
   */
  biologicalNm: { min: number; max: number } | null;
  /** Size of one object as drawn in the whole-cell scene, in nm. */
  renderedNm: number;
  /**
   * Drawn size ÷ typical biological size, rounded. 1 = true scale; values
   * above 1 mean the object is enlarged so it stays visible. null = symbolic.
   */
  enlargement: number | null;
  /**
   * Objects drawn at each quality level. `null` = not a countable object
   * (e.g. the cytoplasm or the plasma membrane).
   */
  drawn: { low: number; medium: number; high: number } | null;
}

export interface CloseupView {
  id: string;
  /** Physical length represented by one scene unit, in nm. */
  unitNm: number;
  /**
   * Factor by which molecules are drawn larger than the view's own scale
   * (1 = drawn to scale with each other).
   */
  moleculeEnlargement: number;
  /** Approximate slow-down relative to real time (e.g. 10 = ten times slower); null = not time-based. */
  slowdown: number | null;
}

export interface CloseupInfo {
  views: CloseupView[];
}

export interface StructureRecord {
  id: StructureId;
  slug: string;
  group: GroupId;
  /** Illustrative colour used in the scene and interface (not a biological colour). */
  color: string;
  /** Context text: structures.<id>.sizeContext */
  typicalSize: Claim;
  /** Context text: structures.<id>.quantityContext */
  typicalQuantity: Claim;
  descriptionSources: string[];
  functionSources: string[];
  facts: FactRecord[];
  /** Text: structures.<id>.interesting */
  interesting: Claim;
  /** Values interpolated into prose fields ({name} placeholders). */
  textValues?: Record<string, Quantity>;
  /** Substructure ids; names/definitions in structures.<id>.parts.<partId>. */
  parts: string[];
  related: Relation[];
  model: ModelScale;
  closeup: CloseupInfo;
}

export interface GroupRecord {
  id: GroupId;
  structures: StructureId[];
}
