import { describe, expect, it } from 'vitest';
import { buildPath, isRouteHash, normalizeBase, parseAddress, parseLocation, routeHref, routesEqual, type Route } from '../../src/app/routing';
import { STRUCTURE_META } from '../../src/content/structures';
import { LANGS } from '../../src/i18n/languages';

describe('routes', () => {
  it('round-trips every language × structure × view', () => {
    for (const lang of LANGS) {
      const routes: Route[] = [
        { lang, page: 'cell', structure: null, view: 'cell' },
        { lang, page: 'about', structure: null, view: 'cell' },
      ];
      for (const meta of STRUCTURE_META) {
        routes.push({ lang, page: 'cell', structure: meta.id, view: 'cell' });
        routes.push({ lang, page: 'cell', structure: meta.id, view: 'closeup' });
        meta.closeup.views.forEach((_, index) => {
          if (index > 0) routes.push({ lang, page: 'cell', structure: meta.id, view: 'closeup', detail: index });
        });
      }
      for (const route of routes) {
        for (const base of ['/', '/atlas/']) {
          const url = new URL(buildPath(route, base), 'https://example.org');
          const parsed = parseLocation(url.pathname, url.search, base);
          expect(parsed.kind).toBe('route');
          if (parsed.kind !== 'route') continue;
          expect(parsed.canonical).toBe(true);
          expect(routesEqual(parsed.route, route)).toBe(true);
        }
      }
    }
  });

  it('uses stable, readable paths', () => {
    expect(buildPath({ lang: 'en', page: 'cell', structure: null, view: 'cell' })).toBe('/en/');
    expect(buildPath({ lang: 'fr', page: 'cell', structure: 'mitochondria', view: 'cell' })).toBe('/fr/mitochondria/');
    expect(buildPath({ lang: 'zh', page: 'cell', structure: 'rough-er', view: 'closeup' })).toBe('/zh/rough-endoplasmic-reticulum/?view=closeup');
    expect(buildPath({ lang: 'en', page: 'cell', structure: 'mitochondria', view: 'closeup', detail: 1 })).toBe(
      '/en/mitochondria/?view=closeup&detail=atp-synthase',
    );
    expect(buildPath({ lang: 'sr', page: 'about', structure: null, view: 'cell' }, '/atlas')).toBe('/atlas/sr/about/');
  });

  it('recognises the root, unknown languages and unknown structures', () => {
    expect(parseLocation('/', '')).toEqual({ kind: 'root' });
    expect(parseLocation('/atlas', '', '/atlas/')).toEqual({ kind: 'root' });
    expect(parseLocation('/de/nucleus/', '')).toEqual({ kind: 'not-found', lang: null });
    expect(parseLocation('/en/golgi-body/', '')).toEqual({ kind: 'not-found', lang: 'en' });
    expect(parseLocation('/en/nucleus/extra/', '')).toEqual({ kind: 'not-found', lang: 'en' });
    expect(parseLocation('/other/en/', '', '/atlas/')).toEqual({ kind: 'not-found', lang: null });
  });

  it('accepts non-canonical spellings but flags them for replacement', () => {
    const noSlash = parseLocation('/en/nucleus', '');
    expect(noSlash.kind === 'route' && noSlash.canonical).toBe(false);
    const upper = parseLocation('/EN/Nucleus/', '');
    expect(upper.kind === 'route' && upper.route.structure).toBe('nucleus');
    const indexHtml = parseLocation('/en/nucleus/index.html', '');
    expect(indexHtml.kind === 'route' && indexHtml.route.structure).toBe('nucleus');
    const badDetail = parseLocation('/en/mitochondria/', '?view=closeup&detail=nope');
    expect(badDetail.kind === 'route' && badDetail.canonical).toBe(false);
    expect(badDetail.kind === 'route' && (badDetail.route.detail ?? 0)).toBe(0);
  });

  it('treats the close-up view index as part of the route only in the close-up', () => {
    const a: Route = { lang: 'en', page: 'cell', structure: 'chromosomes', view: 'closeup', detail: 1 };
    expect(routesEqual(a, { ...a, detail: 0 })).toBe(false);
    expect(routesEqual({ ...a, view: 'cell' }, { ...a, view: 'cell', detail: 0 })).toBe(true);
  });

  it('normalises base paths', () => {
    expect(normalizeBase('')).toBe('/');
    expect(normalizeBase('atlas')).toBe('/atlas/');
    expect(normalizeBase('/atlas/')).toBe('/atlas/');
  });

  it('hash routing keeps the whole route after "#" and ignores the page path', () => {
    const closeup: Route = { lang: 'fr', page: 'cell', structure: 'mitochondria', view: 'closeup', detail: 1 };
    const href = routeHref(closeup, '/ignored/', true);
    expect(href).toBe('#/fr/mitochondria/?view=closeup&detail=atp-synthase');
    // The page itself can live at any path; only the hash is read.
    const parsed = parseAddress({ pathname: '/artifact/abc/index.html', search: '?x=1', hash: href }, '/ignored/', true);
    expect(parsed.kind).toBe('route');
    if (parsed.kind === 'route') expect(routesEqual(parsed.route, closeup)).toBe(true);
    expect(parseAddress({ pathname: '/anything/', search: '', hash: '' }, '/', true).kind).toBe('root');
    // Path mode is unchanged.
    expect(routeHref(closeup, '/', false)).toBe(buildPath(closeup, '/'));
  });

  it('tells route hashes from in-page anchors', () => {
    expect(isRouteHash('')).toBe(true);
    expect(isRouteHash('#/en/nucleus/')).toBe(true);
    expect(isRouteHash('#reading-panel')).toBe(false);
    expect(isRouteHash('#atlas-golgi')).toBe(false);
  });
});
