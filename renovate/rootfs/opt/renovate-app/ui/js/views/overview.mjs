// The start page: is everything fine, when does it run next, what is open, and a clear first step if nothing is set up.
import { api } from '../api.mjs';
import { avatar, badge, busy, configurationNotice, reportError, skeleton, toast } from '../components.mjs';
import { h, mount } from '../dom.mjs';
import { duration, number, relativeTime } from '../format.mjs';
import { iconEye, iconPlay, iconPlus } from '../icons.mjs';
import { t } from '../i18n.mjs';
import { poll } from '../poll.mjs';
import { isActive, providerName, runBadge, triggerName } from '../status.mjs';

function emptyOverview(navigate) {
  return h('section', { class: 'card hero' },
    h('img', { class: 'logo', src: 'assets/icon.svg', alt: '' }),
    h('h1', {}, t('overview.empty.title')),
    h('p', {}, t('overview.empty.text')),
    h('div', { class: 'steps' },
      ['connect', 'choose', 'review'].map((key, index) => h('div', { class: 'step' }, h('b', {}, index + 1), h('strong', {}, t(`overview.empty.${key}.title`)), h('span', { class: 'muted small' }, t(`overview.empty.${key}.text`))))),
    h('button', { class: 'btn primary', type: 'button', onclick: () => navigate('/connect') }, iconPlus(), t('overview.empty.cta')));
}

function runNow(refresh) {
  const start = (dryRun) => (event) => busy(event.currentTarget, async () => {
    try {
      await api.post('runs', dryRun ? { dryRun: 'full' } : {});
      toast(t(dryRun ? 'overview.preview_started' : 'overview.run_started'));
      await refresh();
    } catch (error) {
      reportError(error);
    }
  });
  return [
    h('button', { class: 'btn primary', type: 'button', onclick: start(false) }, iconPlay(), t('overview.run_now')),
    h('button', { class: 'btn', type: 'button', title: t('overview.preview_hint'), onclick: start(true) }, iconEye(), t('overview.preview')),
  ];
}

function statusLine(status) {
  if (status.running.length) return t('overview.status.running', { name: status.running.map((run) => run.connectionName).join(', ') });
  if (status.queued) return t('overview.status.queued', { count: status.queued });
  if (status.nextRunAt) return t('overview.status.next', { when: relativeTime(status.nextRunAt) });
  return t('overview.status.manual');
}

function connectionCard(connection, navigate, refresh) {
  const run = async (event) => busy(event.currentTarget, async () => {
    try {
      await api.post('runs', { connectionId: connection.id });
      toast(t('overview.run_started'));
      await refresh();
    } catch (error) {
      reportError(error);
    }
  });
  return h('article', { class: 'card stack' },
    h('div', { class: 'row' }, avatar(connection),
      h('div', { class: 'grow' }, h('strong', {}, connection.name), h('div', { class: 'muted small' }, `${providerName(connection.provider)} · ${connection.accountLogin ?? ''}`)),
      connection.enabled ? null : badge(t('connections.off'), 'warn')),
    h('div', { class: 'muted' }, t('connections.repository_summary', { enabled: connection.enabledRepositoryCount, total: connection.repositoryCount }),
      connection.openPrs ? ` · ${t('connections.open_prs', { count: connection.openPrs })}` : ''),
    connection.lastSyncError ? badge(t('connections.sync_failed'), 'danger') : null,
    h('div', { class: 'row' },
      h('button', { class: 'btn small', type: 'button', onclick: () => navigate(`/connections/${connection.id}`) }, t('common.open')),
      h('button', { class: 'btn small', type: 'button', disabled: !connection.enabled || connection.enabledRepositoryCount === 0, onclick: run }, iconPlay(), t('overview.run_connection'))));
}

function recentRuns(runs, navigate) {
  if (!runs.length) return null;
  return h('section', { class: 'stack' },
    h('div', { class: 'row' }, h('h2', {}, t('overview.recent_runs')), h('span', { class: 'spacer' }), h('a', { href: '#/runs' }, t('overview.all_runs'))),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, t('runs.col.status')), h('th', {}, t('runs.col.connection')), h('th', { class: 'hide-small' }, t('runs.col.trigger')), h('th', {}, t('runs.col.started')), h('th', { class: 'num' }, t('runs.col.prs')))),
      h('tbody', {}, runs.slice(0, 5).map((run) => h('tr', { class: 'clickable', tabindex: '0', onclick: () => navigate(`/runs/${run.id}`), onkeydown: (event) => event.key === 'Enter' && navigate(`/runs/${run.id}`) },
        h('td', {}, runBadge(run)), h('td', {}, run.connectionName), h('td', { class: 'hide-small' }, triggerName(run.trigger)),
        h('td', {}, relativeTime(run.startedAt ?? run.queuedAt)),
        h('td', { class: 'num' }, number((run.summary?.totals?.prsCreated ?? 0) + (run.summary?.totals?.prsUpdated ?? 0)))))))));
}

export async function overview(container, { navigate, refreshChip }) {
  mount(container, skeleton(3));

  async function render() {
    const [connections, status, runs] = await Promise.all([api.get('connections'), api.get('status'), api.get('runs?limit=10')]);
    if (!connections.length) {
      mount(container, configurationNotice(status.configuration), emptyOverview(navigate));
      return;
    }
    const active = status.running.length > 0 || status.queued > 0;
    const watched = connections.reduce((sum, connection) => sum + connection.enabledRepositoryCount, 0);
    const openPrs = connections.reduce((sum, connection) => sum + (connection.openPrs ?? 0), 0);
    const last = runs.find((run) => !isActive(run));
    mount(container,
      configurationNotice(status.configuration),
      h('div', { class: 'page-head' },
        h('div', {}, h('h1', {}, t('overview.title')), h('p', {}, statusLine(status))),
        h('div', { class: 'row' }, ...runNow(async () => { await render(); await refreshChip(); }))),
      h('div', { class: 'tiles' },
        h('div', { class: 'tile' }, h('div', { class: 'value' }, number(openPrs)), h('div', { class: 'label' }, t('overview.tile.open_prs'))),
        h('div', { class: 'tile' }, h('div', { class: 'value' }, number(watched)), h('div', { class: 'label' }, t('overview.tile.repositories'))),
        h('div', { class: 'tile' }, h('div', { class: 'value' }, last ? runBadge(last) : '–'), h('div', { class: 'label' }, last ? `${t('overview.tile.last_run')} · ${relativeTime(last.finishedAt)}${last.finishedAt ? ` (${duration(last.startedAt, last.finishedAt)})` : ''}` : t('overview.tile.last_run'))),
        h('div', { class: 'tile' }, h('div', { class: 'value' }, status.nextRunAt ? relativeTime(status.nextRunAt) : '–'), h('div', { class: 'label' }, t('overview.tile.next_run')))),
      h('section', { class: 'stack' },
        h('div', { class: 'row' }, h('h2', {}, t('overview.connections')), h('span', { class: 'spacer' }), h('button', { class: 'btn small', type: 'button', onclick: () => navigate('/connect') }, iconPlus(), t('connections.add'))),
        h('div', { class: 'grid' }, connections.map((connection) => connectionCard(connection, navigate, render)))),
      recentRuns(runs, navigate));
    return active;
  }

  let active = Boolean(await render());
  const stop = poll(async () => { active = Boolean(await render()); }, () => (active ? 4000 : 20_000));
  return stop;
}
