import { describe, expect, it } from 'vitest';
import { buildSearchIndex, levenshtein, normalize, searchStructures } from '../../src/content/search';
import { createTranslator, type MessageTree } from '../../src/i18n/translator';
import { englishMessages } from '../../src/i18n/load';

const english = createTranslator('en', englishMessages, englishMessages);
const index = buildSearchIndex(english, english);
const top = (query: string) => searchStructures(index, query)[0]?.id;

describe('search', () => {
  it('finds structures by name, synonym and singular forms', () => {
    expect(top('cell membrane')).toBe('plasma-membrane');
    expect(top('mitochondrion')).toBe('mitochondria');
    expect(top('Golgi')).toBe('golgi');
    expect(top('nucleolus')).toBe('nucleolus');
    expect(top('kinesin')).toBe('vesicles-motors');
    expect(searchStructures(index, 'ER').map((h) => h.id)).toEqual(expect.arrayContaining(['rough-er', 'smooth-er']));
  });

  it('tolerates small typos in longer words', () => {
    expect(top('mitocondria')).toBe('mitochondria');
    expect(top('ribosomez')).toBe('ribosomes');
  });

  it('returns nothing for an empty or unknown query', () => {
    expect(searchStructures(index, '   ')).toEqual([]);
    expect(searchStructures(index, 'zzzzqx')).toEqual([]);
  });

  it('ignores case and diacritics', () => {
    expect(normalize('  Réticulum  Endoplasmique ')).toBe('reticulum endoplasmique');
    expect(normalize('ЯДРО')).toBe('ядро');
  });

  it('keeps English names searchable in other languages', () => {
    // A minimal "translation" where every name is replaced: English still matches.
    const fake = JSON.parse(JSON.stringify(englishMessages)) as { structures: Record<string, MessageTree> };
    for (const entry of Object.values(fake.structures)) {
      entry.name = `x-${String(entry.name)}`;
      entry.synonyms = ['zzz'];
    }
    const other = createTranslator('fr', fake as unknown as MessageTree, englishMessages);
    const otherIndex = buildSearchIndex(other, english);
    expect(searchStructures(otherIndex, 'mitochondrion')[0]?.id).toBe('mitochondria');
  });

  it('computes bounded edit distances', () => {
    expect(levenshtein('kitten', 'sitting', 3)).toBe(3);
    expect(levenshtein('abc', 'abcdefgh', 2)).toBe(3);
  });
});
