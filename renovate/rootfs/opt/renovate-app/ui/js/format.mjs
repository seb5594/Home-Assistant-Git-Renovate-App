// Dates, durations and numbers in the user's language.
import { currentLanguage, t } from './i18n.mjs';

const UNITS = [['year', 31_536_000], ['month', 2_592_000], ['day', 86_400], ['hour', 3600], ['minute', 60], ['second', 1]];

/** "3 hours ago" / "in 2 days". */
export function relativeTime(iso, now = Date.now()) {
  if (!iso) return '–';
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const formatter = new Intl.RelativeTimeFormat(currentLanguage(), { numeric: 'auto' });
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size || unit === 'second') return formatter.format(Math.trunc(seconds / size), unit);
  }
  return '–';
}

export function dateTime(iso) {
  if (!iso) return '–';
  return new Intl.DateTimeFormat(currentLanguage(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

export function clock(ms) {
  return new Intl.DateTimeFormat(currentLanguage(), { timeStyle: 'medium', hour12: false }).format(new Date(ms));
}

/** "2 min 05 s" from two timestamps. */
export function duration(startIso, endIso) {
  if (!startIso) return '–';
  const seconds = Math.max(0, Math.round(((endIso ? new Date(endIso) : new Date()) - new Date(startIso)) / 1000));
  if (seconds < 60) return t('time.seconds', { count: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('time.minutes_seconds', { minutes, seconds: String(seconds % 60).padStart(2, '0') });
  return t('time.hours_minutes', { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

export const number = (value) => new Intl.NumberFormat(currentLanguage()).format(value ?? 0);
