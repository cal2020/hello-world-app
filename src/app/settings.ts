import type { QualitySetting } from './quality';
import { isLang, type Lang } from '../i18n/languages';

export type MotionSetting = 'system' | 'reduce' | 'allow';

export interface Settings {
  labels: boolean;
  quality: QualitySetting;
  motion: MotionSetting;
}

export const DEFAULT_SETTINGS: Settings = { labels: true, quality: 'auto', motion: 'system' };

const SETTINGS_KEY = 'hca.settings.v1';
const LANG_KEY = 'hca.lang.v1';

// Storage can be unavailable (private windows, blocked site data); every
// access is guarded so the atlas still works with defaults.
function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function loadSettings(): Settings {
  try {
    const raw = storage()?.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      labels: typeof parsed.labels === 'boolean' ? parsed.labels : DEFAULT_SETTINGS.labels,
      quality: ['auto', 'low', 'medium', 'high'].includes(parsed.quality as string)
        ? (parsed.quality as QualitySetting)
        : DEFAULT_SETTINGS.quality,
      motion: ['system', 'reduce', 'allow'].includes(parsed.motion as string)
        ? (parsed.motion as MotionSetting)
        : DEFAULT_SETTINGS.motion,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    storage()?.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* ignore: preference simply is not remembered */
  }
}

export function loadLanguagePreference(): Lang | null {
  try {
    const value = storage()?.getItem(LANG_KEY);
    return isLang(value) ? value : null;
  } catch {
    return null;
  }
}

export function saveLanguagePreference(lang: Lang): void {
  try {
    storage()?.setItem(LANG_KEY, lang);
  } catch {
    /* ignore */
  }
}
