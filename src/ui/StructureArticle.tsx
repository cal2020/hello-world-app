import type { ReactNode } from 'react';
import { citedSources, source, structure } from '../content/registry';
import { citationLine, claimView, joinSentences, structureField, structureName, structureVars } from '../content/text';
import type { Claim, StructureId } from '../content/types';
import type { InspectView } from '../app/routing';
import type { Translator } from '../i18n/translator';

export interface StructureArticleProps {
  id: StructureId;
  t: Translator;
  /** 'interactive' = reading panel; 'static' = text atlas and prerendered pages. */
  mode: 'interactive' | 'static';
  headingLevel?: 'h1' | 'h2';
  /** Prefix for element ids, so several articles can share a page. */
  idPrefix?: string;
  view?: InspectView;
  closeupViewIndex?: number;
  /** Objects drawn at the current quality, as reported by the renderer. */
  drawn?: number | null;
  qualityLabel?: string;
  bioFrozen?: boolean;
  closeupStatus?: 'idle' | 'loading' | 'ready' | 'error';
  onSelect?: (id: StructureId) => void;
  onView?: (view: InspectView) => void;
  onSubview?: (index: number) => void;
  /** Static mode: link target for a structure. */
  hrefFor?: (id: StructureId) => string;
  /** Static mode: optional illustration (image rendered from the 3D model). */
  illustration?: { src: string; alt: string };
  /** Extra content placed right after the lead (e.g. "open in 3D" link). */
  afterLead?: ReactNode;
}

function Cites({ ids, numbers, prefix, t }: { ids: string[]; numbers: Map<string, number>; prefix: string; t: Translator }) {
  if (ids.length === 0) return null;
  return (
    <span className="cites">
      {ids.map((id) => {
        const n = numbers.get(id) ?? 0;
        return (
          <a key={id} className="cite" href={`#${prefix}src-${id}`} aria-label={t.t('panel.sourceRef', { n })}>
            {n}
          </a>
        );
      })}
    </span>
  );
}

function Pending({ claim, t }: { claim: Claim; t: Translator }) {
  if (!claim.pending) return null;
  return (
    <span className="tag-pending" title={t.t('panel.pendingHint')}>
      {t.t('panel.pending')}
    </span>
  );
}

export function StructureArticle(props: StructureArticleProps) {
  const { id, t, mode } = props;
  const s = structure(id);
  const base = `structures.${id}`;
  const prefix = props.idPrefix ?? '';
  const vars = structureVars(t, id);
  const cited = citedSources(s);
  const numbers = new Map(cited.map((sourceId, index) => [sourceId, index + 1]));
  const Heading = props.headingLevel ?? 'h2';
  const interactive = mode === 'interactive';
  const view = props.view ?? 'cell';
  const subIndex = Math.min(props.closeupViewIndex ?? 0, s.closeup.views.length - 1);
  const closeupView = s.closeup.views[subIndex];

  const size = claimView(t, id, s.typicalSize);
  const quantity = claimView(t, id, s.typicalQuantity);
  const interesting = claimView(t, id, s.interesting);

  const model = s.model;
  const renderedSize =
    model.renderedNm >= 1000
      ? t.formatQuantity({ value: model.renderedNm / 1000, unit: 'um' })
      : t.formatQuantity({ value: model.renderedNm, unit: 'nm' });

  let drawnText: string;
  if (!model.drawn) {
    drawnText = id === 'cytoplasm' ? t.t('panel.drawnSymbolic') : t.t('panel.drawnContinuous');
  } else if (interactive && typeof props.drawn === 'number') {
    drawnText = t.plural('panel.drawnCount', props.drawn, { quality: props.qualityLabel ?? '' });
  } else if (model.drawn.low === model.drawn.high) {
    drawnText = t.plural('panel.drawnFixed', model.drawn.low);
  } else {
    drawnText = t.t('panel.drawnRange', {
      low: t.formatNumber(model.drawn.low),
      high: t.formatNumber(model.drawn.high),
    });
  }
  const scaleText =
    model.enlargement === null
      ? t.t('panel.symbolic')
      : model.enlargement <= 1.05
        ? t.t('panel.trueScale')
        : t.t('panel.enlarged', { factor: t.formatNumber(model.enlargement) });

  const relatedLink = (target: StructureId, kind: string) => {
    const content = (
      <>
        <span className="rel-kind">{t.t(`relations.${kind}`)}</span>
        <span>{structureName(t, target)}</span>
      </>
    );
    if (interactive) {
      return (
        <button type="button" className="btn" onClick={() => props.onSelect?.(target)}>
          {content}
        </button>
      );
    }
    return (
      <a className="btn" href={props.hrefFor?.(target) ?? '#'}>
        {content}
      </a>
    );
  };

  return (
    <article className="article" aria-labelledby={`${prefix}title-${id}`} lang={t.tag}>
      <div className="article-eyebrow" style={{ color: s.color }}>
        <span className="dot" style={{ background: s.color }} aria-hidden="true" />
        <span style={{ color: 'var(--text-3)' }}>
          <span className="visually-hidden">{t.t('panel.groupHidden', { group: t.t(`groups.${s.group}`) })}</span>
          <span aria-hidden="true">{t.t(`groups.${s.group}`)}</span>
        </span>
      </div>
      <Heading className="article-title" id={`${prefix}title-${id}`}>
        {structureName(t, id)}
      </Heading>
      <p className="lead">
        {structureField(t, id, 'short')}
        <Cites ids={s.descriptionSources} numbers={numbers} prefix={prefix} t={t} />
      </p>
      {props.afterLead}

      {props.illustration && (
        <figure className="atlas-figure">
          <img src={props.illustration.src} alt={props.illustration.alt} loading="lazy" decoding="async" />
        </figure>
      )}

      {interactive && (
        <>
          <div className="view-switch" role="group" aria-label={t.t('panel.viewSwitch')}>
            <button type="button" className="btn" aria-pressed={view === 'cell'} onClick={() => props.onView?.('cell')}>
              {t.t('panel.inTheCell')}
            </button>
            <button
              type="button"
              className="btn"
              aria-pressed={view === 'closeup'}
              onClick={() => props.onView?.('closeup')}
              data-testid="closeup-toggle"
            >
              {t.t('panel.closeup')}
            </button>
          </div>
          {view === 'closeup' && s.closeup.views.length > 1 && (
            <div className="subview-switch" role="group" aria-label={t.t('panel.subviews')}>
              {s.closeup.views.map((v, index) => (
                <button
                  key={v.id}
                  type="button"
                  className="btn"
                  aria-pressed={index === subIndex}
                  onClick={() => props.onSubview?.(index)}
                >
                  {t.t(`${base}.views.${v.id}.title`)}
                </button>
              ))}
            </div>
          )}
          {view === 'closeup' && (
            <div className="view-meta" aria-live="polite">
              {props.closeupStatus === 'loading' && <p>{t.t('panel.closeupLoading')}</p>}
              {props.closeupStatus === 'error' && <p style={{ color: 'var(--danger)' }}>{t.t('panel.closeupError')}</p>}
              <p>
                <strong>{t.t(`${base}.views.${closeupView.id}.title`)}</strong>
              </p>
              <p>
                {closeupView.moleculeEnlargement > 1
                  ? t.t('panel.moleculesEnlarged', { factor: t.formatNumber(closeupView.moleculeEnlargement) })
                  : t.t('panel.toScale')}{' '}
                {closeupView.slowdown
                  ? t.t('panel.slowdown', { factor: t.formatNumber(closeupView.slowdown) })
                  : t.t('panel.noTimescale')}
              </p>
              {props.bioFrozen && <p>{t.t('panel.frozen')}</p>}
            </div>
          )}
        </>
      )}

      <h3>{t.t('panel.whatYouSee')}</h3>
      {interactive ? (
        <p>
          {view === 'closeup'
            ? t.t(`${base}.views.${closeupView.id}.seeing`, vars)
            : structureField(t, id, 'seeingCell')}
        </p>
      ) : (
        <>
          <h4>{t.t('panel.inTheCell')}</h4>
          <p>{structureField(t, id, 'seeingCell')}</p>
          {s.closeup.views.map((v) => (
            <div key={v.id}>
              <h4>
                {t.t('panel.closeupTitle', { title: t.t(`${base}.views.${v.id}.title`) })}
              </h4>
              <p>{t.t(`${base}.views.${v.id}.seeing`, vars)}</p>
            </div>
          ))}
        </>
      )}

      <h3>{t.t('panel.whatItDoes')}</h3>
      <p>
        {structureField(t, id, 'function')}
        <Cites ids={s.functionSources} numbers={numbers} prefix={prefix} t={t} />
      </p>

      <h3>{t.t('panel.numbers')}</h3>
      <dl className="numbers">
        <div>
          <dt>{t.t('panel.typicalSize')}</dt>
          <dd>
            {size.value && <span className="value">{size.value}</span>}
            <span className="context">
              {t.t(`${base}.sizeContext`, size.vars)}
              <Cites ids={size.sources} numbers={numbers} prefix={prefix} t={t} />
              <Pending claim={s.typicalSize} t={t} />
            </span>
          </dd>
        </div>
        <div>
          <dt>{t.t('panel.typicalQuantity')}</dt>
          <dd>
            {quantity.value && <span className="value">{quantity.value}</span>}
            <span className="context">
              {t.t(`${base}.quantityContext`, quantity.vars)}
              <Cites ids={quantity.sources} numbers={numbers} prefix={prefix} t={t} />
              <Pending claim={s.typicalQuantity} t={t} />
            </span>
          </dd>
        </div>
        <div>
          <dt>{t.t('panel.drawnInModel')}</dt>
          <dd>
            <span className="value" data-testid="drawn-count">
              {drawnText}
            </span>
            <span className="context">
              {joinSentences(
                t,
                t.t('panel.renderedSize', { dimension: t.t(`dimensions.${model.dimension}`), size: renderedSize }),
                scaleText,
                structureField(t, id, 'sampling'),
              )}
            </span>
          </dd>
        </div>
      </dl>

      <h3>{t.t('panel.facts')}</h3>
      <ul className="facts">
        {s.facts.map((fact) => {
          const view = claimView(t, id, fact);
          return (
            <li key={fact.id}>
              {view.value && <span className="fact-value">{view.value}</span>}
              <span className="fact-label">{t.t(`${base}.facts.${fact.id}.label`, view.vars)}</span>
              <span className="fact-context">
                {t.t(`${base}.facts.${fact.id}.context`, view.vars)}
                <Cites ids={fact.sources} numbers={numbers} prefix={prefix} t={t} />
                <Pending claim={fact} t={t} />
              </span>
            </li>
          );
        })}
      </ul>

      <h3>{t.t('panel.interesting')}</h3>
      <p className="interesting">
        {t.t(`${base}.interesting`, interesting.vars)}
        <Cites ids={interesting.sources} numbers={numbers} prefix={prefix} t={t} />
        <Pending claim={s.interesting} t={t} />
      </p>

      <h3>{t.t('panel.parts')}</h3>
      <dl className="parts">
        {s.parts.map((part) => (
          <div key={part}>
            <dt>{t.t(`${base}.parts.${part}.name`)}</dt>
            <dd>{t.t(`${base}.parts.${part}.def`, vars)}</dd>
          </div>
        ))}
      </dl>

      <h3>{t.t('panel.related')}</h3>
      <ul className="related">
        {s.related.map((rel) => (
          <li key={rel.id}>{relatedLink(rel.id, rel.kind)}</li>
        ))}
      </ul>

      <h3>{t.t('panel.simplifications')}</h3>
      <ul className="simplifications">
        {t.list(`${base}.simplifications`).map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>

      <h3 id={`${prefix}sources-${id}`}>{t.t('panel.sources')}</h3>
      <ol className="sources">
        {cited.map((sourceId) => {
          const record = source(sourceId);
          return (
            <li key={sourceId} id={`${prefix}src-${sourceId}`}>
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
          );
        })}
      </ol>
    </article>
  );
}
