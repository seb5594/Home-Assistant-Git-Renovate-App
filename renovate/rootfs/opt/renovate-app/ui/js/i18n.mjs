// Translations. English is the reference and always loaded, so a missing German text falls back to it.
// Keys are flat ("runs.empty"); {name} placeholders are replaced; a key may have _one/_other variants for counts.
let language = 'en';
let messages = {};
let fallback = {};
let plural = new Intl.PluralRules('en');

export const SUPPORTED = ['en', 'de'];

async function loadLocale(code) {
  const response = await fetch(`locales/${code}.json`);
  if (!response.ok) throw new Error(`Cannot load locale ${code}`);
  return response.json();
}

/** Maps any language tag (de-AT, en_GB, ...) to a supported language. */
export function pickLanguage(tag) {
  const base = String(tag ?? '').toLowerCase().split(/[-_]/)[0];
  return SUPPORTED.includes(base) ? base : 'en';
}

export async function setLanguage(code) {
  language = pickLanguage(code);
  fallback = Object.keys(fallback).length ? fallback : await loadLocale('en');
  messages = language === 'en' ? fallback : await loadLocale(language);
  plural = new Intl.PluralRules(language);
  document.documentElement.lang = language;
}

export const currentLanguage = () => language;

export function t(key, params = {}) {
  let template;
  if (typeof params.count === 'number') {
    const form = plural.select(params.count);
    template = messages[`${key}_${form}`] ?? messages[`${key}_other`] ?? fallback[`${key}_${form}`] ?? fallback[`${key}_other`];
  }
  template ??= messages[key] ?? fallback[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

/** True when a text exists (used for optional hints that only some settings have). */
export const hasText = (key) => key in messages || key in fallback;
