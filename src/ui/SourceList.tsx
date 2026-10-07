import { useMemo, useState } from 'react';
import { GROUPS, STRUCTURES, citedSources, source } from '../content/registry';
import { SOURCES } from '../content/sources';
import { citationLine, joinSentences, structureName } from '../content/text';
import { normalize } from '../content/search';
import type { Translator } from '../i18n/translator';
import type { SourceRecord } from '../content/types';

/** Every source, grouped by the structure that cites it, with an optional filter. */
export function SourceList({ t, filterable }: { t: Translator; filterable: boolean }) {
  const [query, setQuery] = useState('');
  const norm = normalize(query);

  const groups = useMemo(() => {
    const order = GROUPS.flatMap((g) => g.structures);
    return order.map((id) => {
      const s = STRUCTURES.find((x) => x.id === id)!;
      return { id, name: structureName(t, id), sources: citedSources(s).map((sid) => source(sid)) };
    });
  }, [t]);

  const matches = (record: SourceRecord, groupName: string) =>
    !norm ||
    normalize(
      `${record.title} ${record.authors ?? ''} ${record.organization ?? ''} ${record.year ?? ''} ${record.container ?? ''} ${groupName}`,
    ).includes(norm);

  const visible = groups
    .map((group) => ({ ...group, sources: group.sources.filter((record) => matches(record, group.name)) }))
    .filter((group) => group.sources.length > 0);

  return (
    <div>
      <p>
        {joinSentences(t, t.plural('help.sourcesCount', SOURCES.length), SOURCES.some((record) => record.status === 'pending') && t.t('help.sourcePendingNote'))}
      </p>
      {filterable && (
        <label>
          <span className="visually-hidden">{t.t('help.sourcesFilter')}</span>
          <input
            className="source-filter"
            type="search"
            value={query}
            placeholder={t.t('help.sourcesFilter')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      )}
      {visible.length === 0 && <p role="status">{t.t('help.sourcesEmpty', { query })}</p>}
      {visible.map((group) => (
        <section key={group.id} className="source-group" aria-label={group.name}>
          <h4>{group.name}</h4>
          <ul className="sources" style={{ listStyle: 'disc' }}>
            {group.sources.map((record) => (
              <li key={record.id}>
                <span className="src-title">{citationLine(record)}</span>{' '}
                <a href={record.url} target="_blank" rel="noopener noreferrer" lang="en">
                  {record.url.replace(/^https:\/\//, '')}
                </a>
                {record.status === 'pending' && (
                  <span className="tag-pending" title={record.note}>
                    {t.t('panel.sourcePending')}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
