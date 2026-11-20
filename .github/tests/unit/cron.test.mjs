import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';

const { nextRun, parseCron, cronError } = await load('scheduling/cron.mjs');
const utc = (text) => Date.parse(`${text}Z`);
const iso = (ms) => new Date(ms).toISOString().slice(0, 16);

test('every six hours lands on the next multiple', () => {
  assert.equal(iso(nextRun('0 */6 * * *', utc('2026-11-20T12:00:00'))), '2026-11-20T18:00');
  assert.equal(iso(nextRun('0 */6 * * *', utc('2026-11-20T23:59:30'))), '2026-11-21T00:00');
});

test('the next run is strictly after the start time', () => {
  assert.equal(iso(nextRun('30 4 * * *', utc('2026-11-20T04:30:00'))), '2026-11-21T04:30');
});

test('lists, ranges and steps combine', () => {
  assert.equal(iso(nextRun('5,35 9-17/4 * * *', utc('2026-11-20T09:36:00'))), '2026-11-20T13:05');
});

test('weekday and month names work, and Sunday is 0 or 7', () => {
  // 2026-11-20 is a Friday.
  assert.equal(iso(nextRun('0 8 * * mon', utc('2026-11-20T00:00:00'))), '2026-11-23T08:00');
  assert.equal(iso(nextRun('0 8 * * 7', utc('2026-11-20T00:00:00'))), '2026-11-22T08:00');
  assert.equal(iso(nextRun('0 0 1 jan *', utc('2026-11-20T00:00:00'))), '2027-01-01T00:00');
});

test('day of month and weekday are alternatives when both are restricted', () => {
  assert.equal(iso(nextRun('0 0 13 * fri', utc('2026-11-20T01:00:00'))), '2026-11-27T00:00');
  assert.equal(iso(nextRun('0 0 13 * fri', utc('2026-11-12T01:00:00'))), '2026-11-13T00:00');
});

test('aliases expand', () => {
  assert.equal(iso(nextRun('@daily', utc('2026-11-20T12:00:00'))), '2026-11-21T00:00');
  assert.equal(iso(nextRun('@hourly', utc('2026-11-20T12:10:00'))), '2026-11-20T13:00');
});

test('the time zone decides what "3 o\'clock" means, including daylight saving time', () => {
  // Berlin is UTC+1 in November and UTC+2 in July.
  assert.equal(iso(nextRun('0 3 * * *', utc('2026-11-20T00:00:00'), 'Europe/Berlin')), '2026-11-20T02:00');
  assert.equal(iso(nextRun('0 3 * * *', utc('2026-07-20T00:00:00'), 'Europe/Berlin')), '2026-07-20T01:00');
});

test('a leap day is found years ahead', () => {
  assert.equal(iso(nextRun('0 0 29 2 *', utc('2026-11-20T00:00:00'))), '2028-02-29T00:00');
});

test('an impossible date gives null instead of looping forever', () => {
  assert.equal(nextRun('0 0 31 2 *', utc('2026-11-20T00:00:00')), null);
});

test('invalid expressions are reported in plain words', () => {
  assert.match(cronError('* * * *'), /five fields/);
  assert.match(cronError('61 * * * *'), /minute/);
  assert.match(cronError('*/0 * * * *'), /step/);
  assert.match(cronError('5-1 * * * *'), /range/);
  assert.equal(cronError('0 */6 * * *'), null);
  assert.throws(() => parseCron('a b c d e'));
});
