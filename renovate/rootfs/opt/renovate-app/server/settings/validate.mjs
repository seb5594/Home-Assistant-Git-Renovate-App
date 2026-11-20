// Checks one setting value against its definition and returns the normalized value.
import { badRequest } from '../util/errors.mjs';
import { cronError } from '../scheduling/cron.mjs';
import { randomId } from '../security/crypto.mjs';

const MAX_LIST_ITEMS = 100;
const MAX_TEXT = 4096;

function fail(definition, reason) {
  return badRequest('invalid_setting', `${definition.key}: ${reason}`, { key: definition.key });
}

function checkText(definition, value) {
  if (typeof value !== 'string') throw fail(definition, 'must be text');
  const text = value.trim();
  if (text.length > MAX_TEXT) throw fail(definition, 'is too long');
  if (text && definition.pattern && !definition.pattern.test(text)) {
    throw fail(definition, `does not match the expected format${definition.patternHint ? ` (${definition.patternHint})` : ''}`);
  }
  if (text && definition.cron) {
    const problem = cronError(text);
    if (problem) throw fail(definition, problem);
  }
  if (text && definition.validate) {
    const problem = definition.validate(text);
    if (problem) throw fail(definition, problem);
  }
  return text;
}

function checkUrl(definition, value) {
  const text = checkText(definition, value);
  if (!text) return text;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw fail(definition, 'is not a valid address');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw fail(definition, 'must start with http:// or https://');
  return text.replace(/\/+$/, '');
}

function checkList(definition, value) {
  if (!Array.isArray(value)) throw fail(definition, 'must be a list');
  if (value.length > MAX_LIST_ITEMS) throw fail(definition, 'has too many entries');
  return value.map((item) => {
    if (typeof item !== 'string') throw fail(definition, 'entries must be text');
    const text = item.trim();
    if (!text || (definition.itemPattern && !definition.itemPattern.test(text))) {
      throw fail(definition, `entry "${item}" is not valid`);
    }
    return text;
  });
}

function checkRecords(definition, value) {
  if (!Array.isArray(value)) throw fail(definition, 'must be a list');
  if (value.length > MAX_LIST_ITEMS) throw fail(definition, 'has too many entries');
  return value.map((row) => {
    if (!row || typeof row !== 'object') throw fail(definition, 'entries must be objects');
    // A stable id lets the settings page keep stored secrets when rows are reordered or removed.
    const clean = { id: /^[a-f0-9]{6}$/.test(row.id ?? '') ? row.id : randomId(3) };
    for (const field of definition.fields) {
      const raw = row[field.key];
      if (raw === undefined || raw === null || raw === '') {
        if (field.required) throw fail(definition, `${field.key} is required`);
        continue;
      }
      clean[field.key] = checkText({ ...field, key: `${definition.key}.${field.key}` }, raw);
    }
    return clean;
  });
}

/** Normalizes `value` for `definition`; throws an AppError (400) for anything that does not fit. */
export function normalizeValue(definition, value) {
  switch (definition.type) {
    case 'bool':
      if (typeof value !== 'boolean') throw fail(definition, 'must be true or false');
      return value;
    case 'int':
      if (!Number.isInteger(value) || value < definition.min || value > definition.max) {
        throw fail(definition, `must be a whole number from ${definition.min} to ${definition.max}`);
      }
      return value;
    case 'enum':
      if (!definition.values.includes(value)) throw fail(definition, `must be one of ${definition.values.join(', ')}`);
      return value;
    case 'string':
    case 'secret':
      return checkText(definition, value);
    case 'url':
      return checkUrl(definition, value);
    case 'list':
      return checkList(definition, value);
    case 'records':
      return checkRecords(definition, value);
    default:
      throw fail(definition, `has the unsupported type ${definition.type}`);
  }
}

/** True when the value counts as "not set", so the next source in line applies. */
export function isUnset(value) {
  return value === undefined || value === null || value === '' || (typeof value === 'number' && Number.isNaN(value));
}
