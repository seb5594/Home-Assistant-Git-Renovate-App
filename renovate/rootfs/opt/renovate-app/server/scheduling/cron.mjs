// A five-field cron evaluator with time zone support and no dependencies.
//   minute hour day-of-month month day-of-week      (also @hourly, @daily, @weekly, @monthly)
// Supports lists (1,15), ranges (1-5), steps (*/10, 10-40/5) and month/weekday names.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const ALIASES = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
};

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTHS, offset: 1 },
  { name: 'day of week', min: 0, max: 7, names: WEEKDAYS, offset: 0 },
];

function parseNumber(text, field) {
  const named = field.names?.indexOf(text.toLowerCase());
  const value = named !== undefined && named >= 0 ? named + field.offset : Number(text);
  if (!Number.isInteger(value) || value < field.min || value > field.max) {
    throw new Error(`Invalid ${field.name} value "${text}"`);
  }
  return value;
}

function parseField(text, field) {
  const allowed = new Set();
  for (const part of text.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid step in ${field.name} "${part}"`);
    let from;
    let to;
    if (range === '*') {
      [from, to] = [field.min, field.name === 'day of week' ? 6 : field.max];
    } else if (range.includes('-')) {
      const [start, end] = range.split('-');
      [from, to] = [parseNumber(start, field), parseNumber(end, field)];
    } else {
      from = parseNumber(range, field);
      to = stepText === undefined ? from : field.max;
    }
    if (from > to) throw new Error(`Invalid range in ${field.name} "${part}"`);
    for (let value = from; value <= to; value += step) allowed.add(field.name === 'day of week' ? value % 7 : value);
  }
  return allowed;
}

/** @returns {{minute:Set<number>,hour:Set<number>,dom:Set<number>,month:Set<number>,dow:Set<number>,domAny:boolean,dowAny:boolean}} */
export function parseCron(expression) {
  const text = ALIASES[String(expression).trim().toLowerCase()] ?? String(expression).trim();
  const parts = text.split(/\s+/);
  if (parts.length !== 5) throw new Error('A cron expression needs five fields: minute hour day month weekday');
  const [minute, hour, dom, month, dow] = parts.map((part, index) => parseField(part, FIELDS[index]));
  return { minute, hour, dom, month, dow, domAny: parts[2].startsWith('*'), dowAny: parts[4].startsWith('*') };
}

const formatters = new Map();

function localParts(ms, timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    });
    formatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(ms).map(({ type, value }) => [type, value]));
  return {
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAYS.indexOf(parts.weekday.toLowerCase()),
  };
}

// Like Vixie cron: when both day fields are restricted, either one may match.
function dayMatches(spec, { day, weekday }) {
  const byMonthDay = spec.dom.has(day);
  const byWeekday = spec.dow.has(weekday);
  if (spec.domAny && spec.dowAny) return true;
  if (spec.domAny) return byWeekday;
  if (spec.dowAny) return byMonthDay;
  return byMonthDay || byWeekday;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// A yearly job such as "0 0 29 2 *" can be four years away; stop searching after five.
const SEARCH_LIMIT = 5 * 366 * DAY;

/**
 * The first matching minute strictly after `from`.
 * @param {string|ReturnType<typeof parseCron>} expression
 * @param {number} from epoch milliseconds
 * @param {string} timeZone IANA name such as Europe/Berlin
 * @returns {number|null} epoch milliseconds, or null when nothing matches within five years
 */
export function nextRun(expression, from, timeZone = 'UTC') {
  const spec = typeof expression === 'string' ? parseCron(expression) : expression;
  let t = Math.floor(from / MINUTE) * MINUTE + MINUTE;
  const limit = from + SEARCH_LIMIT;
  while (t <= limit) {
    const local = localParts(t, timeZone);
    if (!spec.month.has(local.month) || !dayMatches(spec, local)) {
      // Jump to the start of the next local day.
      t += DAY - (local.hour * 60 + local.minute) * MINUTE;
    } else if (!spec.hour.has(local.hour)) {
      t += HOUR - local.minute * MINUTE;
    } else if (!spec.minute.has(local.minute)) {
      t += MINUTE;
    } else {
      return t;
    }
  }
  return null;
}

/** Validates an expression and returns an error message, or null when it is fine. */
export function cronError(expression) {
  try {
    parseCron(expression);
    return null;
  } catch (error) {
    return error.message;
  }
}
