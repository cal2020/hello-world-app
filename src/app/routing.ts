import { STRUCTURE_META } from '../content/structures';
import type { StructureId } from '../content/types';
import { isLang, type Lang } from '../i18n/languages';

/**
 * URL scheme (all paths end with "/"; BASE is Vite's base path):
 *
 *   BASE                       → language redirect (saved or browser language)
 *   BASE{lang}/                → whole cell
 *   BASE{lang}/{slug}/         → structure, "In the cell" view
 *   BASE{lang}/{slug}/?view=closeup → structure, close-up view
 *   BASE{lang}/about/          → About panel over the whole cell
 *
 * Slugs are stable English identifiers shared by all languages.
 */

export type InspectView = 'cell' | 'closeup';

export interface Route {
  lang: Lang;
  page: 'cell' | 'about';
  structure: StructureId | null;
  view: InspectView;
}

export type ParsedLocation =
  | { kind: 'route'; route: Route; canonical: boolean }
  | { kind: 'root' }
  | { kind: 'not-found'; lang: Lang | null };

const slugToId = new Map<string, StructureId>(STRUCTURE_META.map((s) => [s.slug, s.id]));
const idToSlug = new Map<StructureId, string>(STRUCTURE_META.map((s) => [s.id, s.slug]));

export const ABOUT_SLUG = 'about';

export function slugFor(id: StructureId): string {
  const slug = idToSlug.get(id);
  if (!slug) throw new Error(`Unknown structure id ${id}`);
  return slug;
}

export function structureForSlug(slug: string): StructureId | undefined {
  return slugToId.get(slug);
}

export function normalizeBase(base: string): string {
  let b = base || '/';
  if (!b.startsWith('/')) b = `/${b}`;
  if (!b.endsWith('/')) b = `${b}/`;
  return b;
}

export function buildPath(route: Route, base = '/'): string {
  const prefix = `${normalizeBase(base)}${route.lang}/`;
  if (route.page === 'about') return `${prefix}${ABOUT_SLUG}/`;
  if (!route.structure) return prefix;
  const path = `${prefix}${slugFor(route.structure)}/`;
  return route.view === 'closeup' ? `${path}?view=closeup` : path;
}

export function parseLocation(pathname: string, search: string, base = '/'): ParsedLocation {
  const b = normalizeBase(base);
  let path = pathname;
  // Tolerate a missing trailing slash on the base itself ("/repo" for base "/repo/").
  if (`${path}/` === b) path = b;
  if (!path.startsWith(b)) return { kind: 'not-found', lang: null };
  let rest = path.slice(b.length);
  const hadTrailingSlash = rest === '' || rest.endsWith('/');
  // Static hosts may serve /en/nucleus/index.html.
  rest = rest.replace(/index\.html$/, '');
  const segments = rest.split('/').filter(Boolean).map((s) => decodeURIComponent(s).toLowerCase());
  if (segments.length === 0) return { kind: 'root' };

  const [langSegment, slug, ...extra] = segments;
  if (!isLang(langSegment)) return { kind: 'not-found', lang: null };
  const lang = langSegment;
  if (extra.length > 0) return { kind: 'not-found', lang };

  const params = new URLSearchParams(search);
  const view: InspectView = params.get('view') === 'closeup' ? 'closeup' : 'cell';

  if (!slug) {
    return { kind: 'route', route: { lang, page: 'cell', structure: null, view: 'cell' }, canonical: hadTrailingSlash };
  }
  if (slug === ABOUT_SLUG) {
    return { kind: 'route', route: { lang, page: 'about', structure: null, view: 'cell' }, canonical: hadTrailingSlash };
  }
  const structure = structureForSlug(slug);
  if (!structure) return { kind: 'not-found', lang };
  return { kind: 'route', route: { lang, page: 'cell', structure, view }, canonical: hadTrailingSlash };
}

export function routesEqual(a: Route, b: Route): boolean {
  return a.lang === b.lang && a.page === b.page && a.structure === b.structure && a.view === b.view;
}
