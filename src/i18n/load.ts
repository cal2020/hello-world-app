import en from './locales/en.json';
import { type Lang } from './languages';
import type { MessageTree } from './translator';

export const englishMessages = en as unknown as MessageTree;

// Each non-English locale becomes its own lazily loaded chunk.
const lazyLocales = import.meta.glob<{ default: MessageTree }>(['./locales/*.json', '!./locales/en.json']);

const cache = new Map<Lang, MessageTree>([['en', englishMessages]]);

export class LocaleLoadError extends Error {
  constructor(
    readonly lang: Lang,
    cause?: unknown,
  ) {
    super(`Could not load the "${lang}" locale`, { cause });
    this.name = 'LocaleLoadError';
  }
}

function simulatedFailure(lang: Lang): boolean {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  return params.get('simulate') === 'locale-failure' && lang !== 'en';
}

export function cachedMessages(lang: Lang): MessageTree | undefined {
  return cache.get(lang);
}

export async function loadMessages(lang: Lang): Promise<MessageTree> {
  const cached = cache.get(lang);
  if (cached) return cached;
  if (simulatedFailure(lang)) throw new LocaleLoadError(lang, new Error('Simulated failure (?simulate=locale-failure)'));
  const loader = lazyLocales[`./locales/${lang}.json`];
  if (!loader) throw new LocaleLoadError(lang, new Error('Locale file missing from the build'));
  try {
    const module = await loader();
    const messages = module.default;
    cache.set(lang, messages);
    return messages;
  } catch (error) {
    throw new LocaleLoadError(lang, error);
  }
}
