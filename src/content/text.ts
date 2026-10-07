import type { Translator, Vars } from '../i18n/translator';
import { structure } from './registry';
import { MODEL_TEXT_VALUES } from './science';
import type { Claim, Quantity, StructureId } from './types';

/** Format a map of quantities into interpolation variables for a translator. */
export function formatValues(t: Translator, values?: Record<string, Quantity>): Vars {
  const vars: Vars = {};
  if (!values) return vars;
  for (const [key, quantity] of Object.entries(values)) vars[key] = t.formatQuantity(quantity);
  return vars;
}

export function modelVars(t: Translator): Vars {
  return formatValues(t, MODEL_TEXT_VALUES);
}

/** Variables available to every prose field of a structure. */
export function structureVars(t: Translator, id: StructureId): Vars {
  return { ...modelVars(t), ...formatValues(t, structure(id).textValues) };
}

export function structureName(t: Translator, id: StructureId): string {
  return t.t(`structures.${id}.name`);
}

export function structureField(t: Translator, id: StructureId, field: string): string {
  return t.t(`structures.${id}.${field}`, structureVars(t, id));
}

export interface ClaimView {
  /** Formatted main value, if the claim has one. */
  value?: string;
  /** Interpolation variables for the claim's prose (label/context). */
  vars: Vars;
  sources: string[];
  pending: boolean;
}

export function claimView(t: Translator, id: StructureId, claim: Claim): ClaimView {
  return {
    value: claim.value ? t.formatQuantity(claim.value) : undefined,
    vars: { ...structureVars(t, id), ...formatValues(t, claim.values) },
    sources: claim.sources,
    pending: !!claim.pending,
  };
}

/** Human-readable citation line for a source (used in lists and the export caption). */
export function citationLine(source: {
  authors?: string;
  organization?: string;
  year?: number;
  title: string;
  container?: string;
}): string {
  const who = source.authors || source.organization || '';
  const year = source.year ? ` (${source.year})` : '';
  const container = source.container ? ` ${source.container}.` : '';
  return `${who}${year}. ${source.title}.${container}`.trim();
}

/**
 * Join sentences that are already punctuated. Chinese text runs sentences
 * together without spaces; the other supported languages use one space.
 */
export function joinSentences(t: Translator, ...parts: Array<string | null | undefined | false>): string {
  return parts.filter((part): part is string => !!part).join(t.lang === 'zh' ? '' : ' ');
}

/** Original illustration rendered from a structure's close-up (scripts/illustrations.ts). */
export function illustrationUrl(id: string, base: string = import.meta.env?.BASE_URL ?? '/'): string {
  return `${base}illustrations/${id}.jpg`;
}
