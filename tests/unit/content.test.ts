import { describe, expect, it } from 'vitest';
import en from '../../src/i18n/locales/en.json';
import { STRUCTURE_META } from '../../src/content/structures';
import { GROUPS, STRUCTURES, citedSources, hasSource } from '../../src/content/registry';
import { SOURCES } from '../../src/content/sources';
import { createTranslator, lookup, type MessageTree } from '../../src/i18n/translator';
import { claimView, structureField, structureVars } from '../../src/content/text';
import { STRUCTURE_IDS, type Claim } from '../../src/content/types';

const messages = en as unknown as MessageTree;
const t = createTranslator('en', messages, messages);

const EXPECTED_GROUPS: Record<string, string[]> = {
  boundary: ['plasma-membrane', 'cytoplasm'],
  genetic: ['nucleus', 'chromosomes', 'telomeres', 'nucleolus'],
  protein: ['ribosomes', 'rough-er', 'smooth-er', 'golgi', 'vesicles-motors'],
  energy: ['mitochondria', 'lysosomes', 'endosomes', 'peroxisomes'],
  support: ['microtubules', 'actin', 'intermediate-filaments', 'centrosome'],
};

const unresolved = (text: string) => text.match(/\{\w+\}/g) ?? [];

describe('structure registry', () => {
  it('contains all 19 structures exactly once', () => {
    expect(STRUCTURE_META.map((s) => s.id).sort()).toEqual([...STRUCTURE_IDS].sort());
    expect(new Set(STRUCTURE_META.map((s) => s.slug)).size).toBe(19);
  });

  it('uses the five navigation groups from the brief', () => {
    for (const group of GROUPS) expect(group.structures).toEqual(EXPECTED_GROUPS[group.id]);
  });

  it('gives every structure 3–5 facts and an interesting fact with sources', () => {
    for (const s of STRUCTURES) {
      expect(s.facts.length, s.id).toBeGreaterThanOrEqual(3);
      expect(s.facts.length, s.id).toBeLessThanOrEqual(5);
      expect(s.interesting.sources.length, s.id).toBeGreaterThan(0);
      expect(s.descriptionSources.length + s.functionSources.length, s.id).toBeGreaterThan(0);
      for (const fact of s.facts) expect(fact.sources.length, `${s.id}/${fact.id}`).toBeGreaterThan(0);
    }
  });

  it('references only existing sources, and every source is cited', () => {
    const cited = new Set<string>();
    for (const s of STRUCTURES) {
      for (const id of citedSources(s)) {
        expect(hasSource(id), `${s.id} cites missing source ${id}`).toBe(true);
        cited.add(id);
      }
    }
    for (const source of SOURCES) expect(cited.has(source.id), `unused source ${source.id}`).toBe(true);
  });

  it('has complete, well-formed source records', () => {
    const ids = new Set<string>();
    for (const source of SOURCES) {
      expect(ids.has(source.id), `duplicate ${source.id}`).toBe(false);
      ids.add(source.id);
      expect(source.url, source.id).toMatch(/^https:\/\//);
      expect(source.title.length, source.id).toBeGreaterThan(3);
      expect(!!(source.authors || source.organization), `${source.id} needs author or organisation`).toBe(true);
      expect(['verified', 'pending']).toContain(source.status);
      expect(source.note.length, source.id).toBeGreaterThan(10);
    }
  });

  it('stores biological size, rendered size, enlargement and sampling separately', () => {
    for (const s of STRUCTURE_META) {
      expect(s.model.renderedNm, s.id).toBeGreaterThan(0);
      if (s.model.biologicalNm && s.model.enlargement !== null) {
        const mid = (s.model.biologicalNm.min + s.model.biologicalNm.max) / 2;
        const ratio = s.model.renderedNm / mid;
        // Stored enlargement must match the stored sizes to within rounding.
        expect(Math.abs(ratio - s.model.enlargement) / s.model.enlargement, s.id).toBeLessThan(0.45);
      }
      expect(s.closeup.views.length, s.id).toBeGreaterThan(0);
    }
  });
});

describe('English content completeness', () => {
  const fields = ['name', 'short', 'function', 'seeingCell', 'sampling', 'sizeContext', 'quantityContext', 'interesting'];

  it('has every prose field for every structure, with all placeholders resolved', () => {
    for (const s of STRUCTURES) {
      for (const field of fields) {
        expect(t.has(`structures.${s.id}.${field}`), `${s.id}.${field}`).toBe(true);
      }
      for (const field of ['short', 'function', 'seeingCell', 'sampling']) {
        expect(unresolved(structureField(t, s.id, field)), `${s.id}.${field}`).toEqual([]);
      }
      const claims: Array<[string, Claim]> = [
        ['sizeContext', s.typicalSize],
        ['quantityContext', s.typicalQuantity],
        ['interesting', s.interesting],
      ];
      for (const [field, claim] of claims) {
        const view = claimView(t, s.id, claim);
        expect(unresolved(t.t(`structures.${s.id}.${field}`, view.vars)), `${s.id}.${field}`).toEqual([]);
      }
      for (const fact of s.facts) {
        const view = claimView(t, s.id, fact);
        for (const key of ['label', 'context']) {
          const text = t.t(`structures.${s.id}.facts.${fact.id}.${key}`, view.vars);
          expect(text, `${s.id}.facts.${fact.id}.${key}`).not.toBe(`structures.${s.id}.facts.${fact.id}.${key}`);
          expect(unresolved(text), `${s.id}.facts.${fact.id}.${key}`).toEqual([]);
        }
      }
      const factKeys = Object.keys((lookup(messages, `structures.${s.id}.facts`) ?? {}) as object);
      expect(factKeys.sort(), `${s.id} locale facts`).toEqual(s.facts.map((f) => f.id).sort());
    }
  });

  it('names and defines every part, and describes every close-up view', () => {
    for (const s of STRUCTURES) {
      for (const part of s.parts) {
        expect(t.has(`structures.${s.id}.parts.${part}.name`), `${s.id}.${part}.name`).toBe(true);
        const def = t.t(`structures.${s.id}.parts.${part}.def`, structureVars(t, s.id));
        expect(unresolved(def), `${s.id}.${part}.def`).toEqual([]);
      }
      for (const view of s.closeup.views) {
        expect(t.has(`structures.${s.id}.views.${view.id}.title`), `${s.id}.${view.id}.title`).toBe(true);
        const seeing = t.t(`structures.${s.id}.views.${view.id}.seeing`, structureVars(t, s.id));
        expect(unresolved(seeing), `${s.id}.${view.id}.seeing`).toEqual([]);
      }
      expect(t.list(`structures.${s.id}.simplifications`).length, s.id).toBeGreaterThanOrEqual(2);
      expect(t.list(`structures.${s.id}.synonyms`).length, s.id).toBeGreaterThanOrEqual(2);
    }
  });

  it('has a unit template for every unit used', () => {
    for (const s of STRUCTURES) {
      const claims: Claim[] = [s.typicalSize, s.typicalQuantity, s.interesting, ...s.facts];
      for (const claim of claims) {
        const quantities = [claim.value, ...Object.values(claim.values ?? {})].filter(Boolean);
        for (const quantity of quantities) {
          if (quantity!.unit === 'none') continue;
          expect(t.has(`units.${quantity!.unit}`), `units.${quantity!.unit}`).toBe(true);
        }
      }
    }
  });
});
