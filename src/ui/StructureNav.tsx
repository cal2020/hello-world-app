import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useApp, useT } from '../app/store';
import { selectStructure, setHovered, setListOpen } from '../app/actions';
import { GROUPS, structure } from '../content/registry';
import { buildSearchIndex, searchStructures } from '../content/search';
import { structureName } from '../content/text';
import type { StructureId } from '../content/types';
import { createTranslator } from '../i18n/translator';
import { englishMessages } from '../i18n/load';
import { Icon } from './icons';

const SUGGESTIONS: StructureId[] = ['nucleus', 'mitochondria', 'rough-er'];
const englishTranslator = createTranslator('en', englishMessages, englishMessages);

export function StructureNav() {
  const t = useT();
  const layout = useApp((s) => s.layout);
  const selected = useApp((s) => (s.route.page === 'cell' ? s.route.structure : null));
  const hovered = useApp((s) => s.hovered);
  const [query, setQuery] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const index = useMemo(() => buildSearchIndex(t, englishTranslator), [t]);
  const hits = useMemo(() => searchStructures(index, query), [index, query]);
  const searching = query.trim().length > 0;

  const choose = (id: StructureId, source: 'list' | 'search') => {
    selectStructure(id, { source });
    if (source === 'search') setQuery('');
  };

  // Keep the selected entry visible in the list.
  useEffect(() => {
    if (!selected || searching) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-structure="${selected}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected, searching]);

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && hits[0]) {
      event.preventDefault();
      choose(hits[0].id, 'search');
    } else if (event.key === 'ArrowDown') {
      const first = listRef.current?.querySelector<HTMLElement>('button.nav-item');
      if (first) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = Array.from(listRef.current?.querySelectorAll<HTMLElement>('button.nav-item') ?? []);
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (current < 0) return;
    event.preventDefault();
    event.stopPropagation();
    const next = event.key === 'ArrowDown' ? Math.min(items.length - 1, current + 1) : current - 1;
    if (next < 0) document.getElementById('structure-search')?.focus();
    else items[next].focus();
  };

  const item = (id: StructureId, source: 'list' | 'search', matched?: string) => {
    const color = structure(id).color;
    const name = structureName(t, id);
    return (
      <li key={id}>
        <button
          type="button"
          className={`nav-item${hovered === id ? ' is-hovered' : ''}`}
          aria-current={selected === id ? 'true' : undefined}
          data-structure={id}
          onClick={() => choose(id, source)}
          onMouseEnter={() => setHovered(id)}
          onMouseLeave={() => setHovered(null)}
          onFocus={() => setHovered(id)}
          onBlur={() => setHovered(null)}
        >
          <span className="dot" style={{ background: color, color }} aria-hidden="true" />
          <span className="nav-item-label">
            {name}
            {matched && matched.toLowerCase() !== name.toLowerCase() && (
              <span className="nav-item-match">{t.t('search.matched', { term: matched })}</span>
            )}
          </span>
        </button>
      </li>
    );
  };

  return (
    <>
      <div className="nav-scrim" onClick={() => setListOpen(false)} aria-hidden="true" />
      <nav id="structure-nav" className="nav-panel glass" aria-label={t.t('nav.structures')}>
        <div className="nav-header">
          <div className="nav-title-row">
            <h2 className="nav-title">{t.t('nav.structures')}</h2>
            {layout !== 'wide' && (
              <button type="button" className="btn btn-icon btn-ghost" aria-label={t.t('nav.hideList')} onClick={() => setListOpen(false)}>
                <Icon name="close" />
              </button>
            )}
          </div>
          <div className="search" role="search">
            <span className="search-icon">
              <Icon name="search" />
            </span>
            <label htmlFor="structure-search" className="visually-hidden">
              {t.t('search.label')}
            </label>
            <input
              id="structure-search"
              type="search"
              autoComplete="off"
              spellCheck={false}
              value={query}
              placeholder={t.t('search.placeholder')}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKey}
              aria-describedby="search-status"
              data-testid="search-input"
            />
            {searching && (
              <button type="button" className="btn btn-icon btn-ghost search-clear" aria-label={t.t('search.clear')} onClick={() => setQuery('')}>
                <Icon name="close" />
              </button>
            )}
          </div>
        </div>
        <div className="nav-scroll" ref={listRef} onKeyDown={onListKey}>
          <div id="search-status" className={searching ? 'search-status' : 'visually-hidden'} role="status" aria-live="polite">
            {searching ? t.plural('search.results', hits.length) : ''}
          </div>
          {searching ? (
            hits.length > 0 ? (
              <ul className="nav-list" data-testid="search-results">
                {hits.map((hit) => item(hit.id, 'search', hit.matched))}
              </ul>
            ) : (
              <div className="search-empty" data-testid="search-empty">
                <p>{t.t('search.empty', { query })}</p>
                <p>{t.t('search.emptyHint')}</p>
                <p className="visually-hidden">{t.t('search.suggestions')}</p>
                <div className="search-suggestions">
                  {SUGGESTIONS.map((id) => (
                    <button key={id} type="button" className="btn" onClick={() => choose(id, 'search')}>
                      {structureName(t, id)}
                    </button>
                  ))}
                </div>
              </div>
            )
          ) : (
            GROUPS.map((group) => (
              <section className="nav-group" key={group.id} aria-labelledby={`group-${group.id}`}>
                <h3 className="nav-group-title" id={`group-${group.id}`}>
                  <span>{t.t(`groups.${group.id}`)}</span>
                </h3>
                <ul className="nav-list">{group.structures.map((id) => item(id, 'list'))}</ul>
              </section>
            ))
          )}
        </div>
      </nav>
    </>
  );
}
