// Refreshes a view on a timer, but only while the page is visible: a hidden tab costs the server nothing.
/**
 * @param {() => Promise<void>} refresh
 * @param {() => number} interval milliseconds until the next refresh, decided after each one
 * @returns {() => void} stop function
 */
export function poll(refresh, interval) {
  let timer = null;
  let stopped = false;

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      if (!document.hidden) await refresh().catch(() => {});
      schedule();
    }, interval());
  };
  const onVisible = () => {
    if (!document.hidden && !stopped) {
      clearTimeout(timer);
      refresh().catch(() => {}).finally(schedule);
    }
  };
  document.addEventListener('visibilitychange', onVisible);
  schedule();

  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
