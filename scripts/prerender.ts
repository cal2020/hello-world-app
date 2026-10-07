/**
 * Prerender: after `vite build`, writes a real HTML page for every route
 * (7 languages × whole cell, 19 structures and About), the root page, a 404
 * page, and — when SITE_URL is set — sitemap.xml with absolute URLs.
 *
 * Each page carries its own title, description, canonical URL, hreflang
 * alternates and the complete text of that page, so the atlas is readable
 * without JavaScript and link previews show the right content.
 *
 *   BASE_PATH=/sub/path/  deploy below a sub-path (default "/")
 *   SITE_URL=https://example.org  absolute canonical/hreflang URLs and sitemap
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import type { HeadInfo } from '../src/app/head';
import type { Route } from '../src/app/routing';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const ssrOut = join(root, 'node_modules', '.prerender');
const base = normalizeBase(process.env.BASE_PATH ?? '/');
const siteUrl = (process.env.SITE_URL ?? '').replace(/\/+$/, '');

function normalizeBase(value: string): string {
  let b = value || '/';
  if (!b.startsWith('/')) b = `/${b}`;
  if (!b.endsWith('/')) b = `${b}/`;
  return b;
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function headTags(head: HeadInfo): string {
  const abs = (path: string) => `${siteUrl}${path}`;
  const lines = [
    `<meta name="description" content="${escapeHtml(head.description)}" />`,
    `<link rel="canonical" href="${escapeHtml(abs(head.canonicalPath))}" />`,
    ...head.alternates.map((alt) => `<link rel="alternate" hreflang="${alt.hreflang}" href="${escapeHtml(abs(alt.path))}" />`),
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${escapeHtml(head.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(head.description)}" />`,
    `<meta property="og:locale" content="${head.langTag.replace('-', '_')}" />`,
  ];
  if (siteUrl) lines.push(`<meta property="og:url" content="${escapeHtml(abs(head.canonicalPath))}" />`);
  return lines.join('\n    ');
}

function fill(template: string, head: HeadInfo, html: string): string {
  return template
    .replace(/<html lang="[^"]*">/, `<html lang="${head.langTag}">`)
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(head.title)}</title>`)
    .replace('<!--app-head-->', headTags(head))
    .replace('<body>', '<body class="atlas-page">')
    .replace('<!--app-html-->', html);
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Output file for a route path such as "/sub/fr/nucleus/". */
function fileFor(path: string): string {
  const relative = path.slice(base.length);
  return join(dist, relative, 'index.html');
}

async function main(): Promise<void> {
  const template = readFileSync(join(dist, 'index.html'), 'utf8');
  if (!template.includes('<!--app-html-->')) throw new Error('dist/index.html has no <!--app-html--> placeholder');

  await build({
    root,
    base,
    logLevel: 'warn',
    build: { ssr: 'src/entry-server.tsx', outDir: ssrOut, emptyOutDir: true, rolldownOptions: { output: { format: 'es' } } },
  });
  const entry = (await import(pathToFileURL(join(ssrOut, 'entry-server.js')).href)) as typeof import('../src/entry-server');
  const { buildPath } = (await import('../src/app/routing')) as typeof import('../src/app/routing');

  const written: string[] = [];
  for (const lang of entry.languages) {
    for (const route of entry.routesFor(lang)) {
      const { html, head } = entry.renderPage(route, base);
      const path = buildPath(route, base);
      write(fileFor(path), fill(template, head, html));
      written.push(path);
    }
  }

  // Root: English content (the app redirects to the reader's language at start-up).
  const englishHome: Route = { lang: 'en', page: 'cell', structure: null, view: 'cell' };
  const rootPage = entry.renderPage(englishHome, base);
  write(join(dist, 'index.html'), fill(template, rootPage.head, rootPage.html));

  // 404 page for static hosts (served for unknown paths; the app shows the whole cell and a notice).
  const notFound = entry.renderPage(englishHome, base, { notFound: true });
  write(join(dist, '404.html'), fill(template, { ...notFound.head, title: `404 · ${notFound.head.title}` }, notFound.html));

  const robots = [`User-agent: *`, `Allow: /`];
  if (siteUrl) {
    const urls = written.map((path) => `  <url><loc>${escapeHtml(siteUrl + path)}</loc></url>`).join('\n');
    write(join(dist, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
    robots.push(`Sitemap: ${siteUrl}${base}sitemap.xml`);
  }
  write(join(dist, 'robots.txt'), `${robots.join('\n')}\n`);

  rmSync(ssrOut, { recursive: true, force: true });
  const missing = 7 - entry.languages.length;
  console.log(
    `Prerendered ${written.length} pages in ${entry.languages.length} languages (+ root and 404)${siteUrl ? ', sitemap.xml' : ' (set SITE_URL for absolute URLs and a sitemap)'}.`,
  );
  if (missing > 0) console.warn(`Warning: ${missing} language(s) have no locale file and were skipped.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
