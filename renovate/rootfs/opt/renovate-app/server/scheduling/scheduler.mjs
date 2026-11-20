// Fires `trigger` on a cron expression or at a fixed interval. One timer, no polling: between two runs the
// process sleeps, which matters on a small machine.
import { nextRun } from './cron.mjs';
import { log } from '../util/log.mjs';

// setTimeout cannot wait longer than about 24.8 days; longer waits are split.
const MAX_DELAY_MS = 2 ** 31 - 1;

/**
 * @param {object} options
 * @param {() => {mode:string, cron:string, intervalMinutes:number, timeZone:string}} options.getSchedule
 * @param {() => void} options.trigger
 * @param {() => number} [options.now]
 * @param {{setTimeout:Function, clearTimeout:Function}} [options.timers] replaceable in tests
 */
export function createScheduler({ getSchedule, trigger, now = Date.now, timers = { setTimeout, clearTimeout } }) {
  let timer = null;
  let nextAt = null;

  function computeNext(schedule, from) {
    if (schedule.mode === 'interval') return from + schedule.intervalMinutes * 60_000;
    if (schedule.mode === 'cron') return nextRun(schedule.cron, from, schedule.timeZone);
    return null;
  }

  function arm(at) {
    nextAt = at;
    if (at === null) return;
    const delay = Math.max(0, at - now());
    timer = timers.setTimeout(() => {
      timer = null;
      if (now() < at - 1000) {
        arm(at);
        return;
      }
      try {
        trigger();
      } catch (error) {
        log.error('The scheduled run could not be queued', error);
      }
      arm(computeNext(getSchedule(), Math.max(now(), at)));
    }, Math.min(delay, MAX_DELAY_MS));
    timer.unref?.();
  }

  const api = {
    /** (Re)reads the schedule and sets the timer. Call it again whenever the schedule settings change. */
    reschedule() {
      if (timer) timers.clearTimeout(timer);
      timer = null;
      let at = null;
      try {
        at = computeNext(getSchedule(), now());
      } catch (error) {
        log.error('The schedule is invalid, so no automatic runs are planned', error);
      }
      arm(at);
      if (at) log.info(`Next automatic run: ${new Date(at).toISOString()}`);
      return at;
    },
    nextRunAt: () => nextAt,
    stop() {
      if (timer) timers.clearTimeout(timer);
      timer = null;
      nextAt = null;
    },
  };
  return api;
}
