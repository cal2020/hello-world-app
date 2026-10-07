import type { Translator } from '../i18n/translator';
import { STRUCTURE_META } from './structures';
import type { StructureId } from './types';

/**
 * Structure search. Matches localized names and synonyms, and always also
 * the English names and synonyms (people often know the English term), plus
 * part names with a lower weight. Diacritics and case are ignored; small
 * typos are tolerated for longer words.
 */

export interface SearchTerm {
  text: string;
  norm: string;
  weight: number;
}

export interface SearchEntry {
  id: StructureId;
  terms: SearchTerm[];
}

export interface SearchHit {
  id: StructureId;
  score: number;
  /** The term that matched (for display when it is not the name). */
  matched: string;
}

export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function levenshtein(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    let rowMin = prev[0];
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
      rowMin = Math.min(rowMin, prev[j]);
    }
    if (rowMin > max) return max + 1;
  }
  return prev[b.length];
}

export function buildSearchIndex(t: Translator, english?: Translator): SearchEntry[] {
  return STRUCTURE_META.map((meta) => {
    const terms: SearchTerm[] = [];
    const add = (text: string, weight: number) => {
      const norm = normalize(text);
      if (norm && !terms.some((term) => term.norm === norm)) terms.push({ text, norm, weight });
    };
    const base = `structures.${meta.id}`;
    add(t.t(`${base}.name`), 1);
    for (const synonym of t.list(`${base}.synonyms`)) add(synonym, 0.95);
    if (english && english !== t) {
      add(english.t(`${base}.name`), 0.9);
      for (const synonym of english.list(`${base}.synonyms`)) add(synonym, 0.85);
    }
    for (const part of meta.parts) add(t.t(`${base}.parts.${part}.name`), 0.5);
    return { id: meta.id, terms };
  });
}

function scoreTerm(query: string, term: string): number {
  if (term === query) return 100;
  if (term.startsWith(query)) return 85 - Math.min(20, term.length - query.length);
  const words = term.split(' ');
  if (words.some((w) => w.startsWith(query))) return 70;
  if (query.includes(' ') && term.includes(query)) return 65;
  if (term.includes(query)) return query.length >= 2 ? 50 : 0;
  // Multi-word queries: every query word must prefix-match some term word.
  const queryWords = query.split(' ');
  if (queryWords.length > 1 && queryWords.every((qw) => words.some((w) => w.startsWith(qw)))) return 60;
  // Typo tolerance for words of five or more letters.
  if (query.length >= 5) {
    const max = query.length >= 9 ? 2 : 1;
    for (const word of [term, ...words]) {
      if (levenshtein(query, word, max) <= max) return 40;
      if (word.length > query.length && levenshtein(query, word.slice(0, query.length), max) <= max) return 35;
    }
  }
  return 0;
}

export function searchStructures(index: SearchEntry[], rawQuery: string): SearchHit[] {
  const query = normalize(rawQuery);
  if (!query) return [];
  const hits: SearchHit[] = [];
  for (const entry of index) {
    let best = 0;
    let matched = '';
    for (const term of entry.terms) {
      const score = scoreTerm(query, term.norm) * term.weight;
      if (score > best) {
        best = score;
        matched = term.text;
      }
    }
    if (best > 0) hits.push({ id: entry.id, score: best, matched });
  }
  return hits.sort((a, b) => b.score - a.score);
}
