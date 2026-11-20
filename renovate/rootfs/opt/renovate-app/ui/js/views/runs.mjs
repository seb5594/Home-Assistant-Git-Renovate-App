// Run history and the detail page of one run: result per repository, hints for known problems and the log.
import { api } from '../api.mjs';
import { badge, busy, emptyState, notice, reportError, skeleton, toast } from '../components.mjs';
import { h, mount } from '../dom.mjs';
import { clock, dateTime, duration, number, relativeTime } from '../format.mjs';
import { iconDownload, iconRefresh, iconStop } from '../icons.mjs';
import { hasText, t } from '../i18n.mjs';
import { poll } from '../poll.mjs';
import { isActive, runBadge, triggerName } from '../status.mjs';

const resultSummary = (run) => {
  const totals = run.summary?.totals;
  if (!totals) return '–';
  return t('runs.result', { created: totals.prsCreated, updated: totals.prsUpdated });
};

export async function runsList(container, { navigate }) {
  mount(container, skeleton(2));
  const [connections] = await Promise.all([api.get('connections')]);
  let filter = '';
  const body = h('tbody');
  const wrap = h('div', { class: 'stack' });

  async function load() {
    const runs = await api.get(`runs?limit=100${filter ? `&connection=${filter}` : ''}`);
    mount(wrap, runs.length
      ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, t('runs.col.status')), h('th', {}, t('runs.col.connection')), h('th', { class: 'hide-small' }, t('runs.col.trigger')), h('th', {}, t('runs.col.started')), h('th', { class: 'hide-small' }, t('runs.col.duration')), h('th', {}, t('runs.col.result')))),
        mount(body, runs.map((run) => h('tr', { class: 'clickable', tabindex: '0', onclick: () => navigate(`/runs/${run.id}`), onkeydown: (event) => event.key === 'Enter' && navigate(`/runs/${run.id}`) },
          h('td', {}, runBadge(run)), h('td', {}, run.connectionName), h('td', { class: 'hide-small' }, triggerName(run.trigger)), h('td', { title: dateTime(run.startedAt ?? run.queuedAt) }, relativeTime(run.startedAt ?? run.queuedAt)),
          h('td', { class: 'hide-small' }, duration(run.startedAt, run.finishedAt)), h('td', {}, resultSummary(run)))))))
      : emptyState(t('runs.empty.title'), t('runs.empty.text')));
    return runs.some(isActive);
  }

  mount(container,
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, t('runs.title')), h('p', {}, t('runs.subtitle'))),
      h('select', { 'aria-label': t('runs.filter'), onchange: (event) => { filter = event.target.value; load(); } },
        h('option', { value: '' }, t('runs.all_connections')), connections.map((connection) => h('option', { value: connection.id }, connection.name)))),
    wrap);
  let active = Boolean(await load());
  return poll(async () => { active = Boolean(await load()); }, () => (active ? 3000 : 15_000));
}

// --- detail ---------------------------------------------------------------------------------------

function logLine(entry) {
  const details = entry.x ? Object.entries(entry.x).map(([key, value]) => `${key}=${value}`).join(' ') : '';
  return h('div', { class: ['log-line', entry.l] },
    h('span', { class: 'time' }, clock(entry.t)), h('span', { class: 'lvl' }, entry.l),
    h('span', { class: 'msg' }, entry.r ? h('span', { class: 'repo' }, `[${entry.r}] `) : null, entry.m, details ? h('span', { class: 'muted' }, ` ${details}`) : null));
}

function logViewer(runId, getRun) {
  let level = 'info';
  let follow = true;
  let source = null;
  let offset = 0;
  let lines = [];
  const view = h('div', { class: 'log', role: 'log', tabindex: '0', 'aria-label': t('runs.log') });
  const more = h('button', { class: 'btn small', type: 'button', hidden: true, onclick: () => loadPage() }, t('runs.log_more'));

  const levels = ['debug', 'info', 'warn', 'error'];
  const keep = (entry) => levels.indexOf(entry.l === 'trace' ? 'debug' : entry.l === 'fatal' ? 'error' : entry.l) >= levels.indexOf(level);
  const add = (entries) => {
    for (const entry of entries) {
      lines.push(entry);
      view.append(logLine(entry));
    }
    if (follow) view.scrollTop = view.scrollHeight;
  };

  async function loadPage() {
    const page = await api.get(`runs/${runId}/log?level=${level}&offset=${offset}&limit=1000`);
    add(page.entries);
    offset = page.nextOffset;
    more.hidden = offset >= page.size;
    return page;
  }

  function stream() {
    source?.close();
    if (!isActive(getRun())) return;
    source = new EventSource(`api/runs/${runId}/stream?from=${offset}`);
    source.addEventListener('log', (event) => { const entry = JSON.parse(event.data); if (keep(entry)) add([entry]); });
    source.addEventListener('run', (event) => { if (!['queued', 'running'].includes(JSON.parse(event.data).status)) source.close(); });
    source.onerror = () => source.close();
  }

  async function reload() {
    source?.close();
    view.replaceChildren();
    lines = [];
    offset = 0;
    await loadPage();
    stream();
  }

  const download = () => {
    const text = lines.map((entry) => `${new Date(entry.t).toISOString()} ${entry.l.toUpperCase()} ${entry.r ? `[${entry.r}] ` : ''}${entry.m}`).join('\n');
    const link = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: `renovate-run-${runId}.log` });
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const element = h('section', { class: 'stack' },
    h('div', { class: 'row' }, h('h2', {}, t('runs.log')), h('span', { class: 'spacer' }),
      h('select', { 'aria-label': t('runs.log_level'), onchange: (event) => { level = event.target.value; reload(); } },
        levels.map((key) => h('option', { value: key, selected: key === level }, t(`runs.level.${key}`)))),
      h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: follow, onchange: (event) => { follow = event.target.checked; } }), t('runs.follow')),
      h('button', { class: 'btn small', type: 'button', onclick: download }, iconDownload(), t('runs.download'))),
    view, more);
  return { element, reload, close: () => source?.close(), restream: stream };
}

function repositoryResult(name, result) {
  const problems = result.errors + result.warnings;
  return h('details', { class: 'card flat' },
    h('summary', { class: 'row' }, h('strong', {}, name), h('span', { class: 'spacer' }),
      result.prsCreated ? badge(t('runs.prs_created', { count: result.prsCreated }), 'ok') : null,
      result.prsUpdated ? badge(t('runs.prs_updated', { count: result.prsUpdated }), 'accent') : null,
      result.pending ? badge(t('runs.pending', { count: result.pending })) : null,
      result.errors ? badge(t('runs.errors', { count: result.errors }), 'danger') : result.warnings ? badge(t('runs.warnings', { count: result.warnings }), 'warn') : null),
    h('div', { class: 'stack' },
      result.branches.length ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, t('runs.col.pr')), h('th', {}, t('runs.col.changes')), h('th', {}, t('runs.col.state')))),
        h('tbody', {}, result.branches.map((branch) => h('tr', {},
          h('td', {}, branch.prNo ? `#${branch.prNo}` : '–', branch.prTitle ? h('div', { class: 'small muted' }, branch.prTitle) : h('div', { class: 'small muted mono' }, branch.name)),
          h('td', {}, branch.upgrades.map((upgrade) => h('div', { class: 'small' }, `${upgrade.depName ?? '?'}: ${upgrade.from ?? '?'} → ${upgrade.to ?? '?'}`))),
          h('td', {}, branch.result ? t(`runs.branch.${branch.result}`) : '–')))))) : h('p', { class: 'muted' }, t('runs.no_branches')),
      problems ? h('ul', {}, result.problems.map((problem) => h('li', {}, badge(t(`runs.level.${problem.level}`), problem.level === 'error' ? 'danger' : 'warn'), ` ${problem.message}`))) : null));
}

export async function runDetail(container, { params: [idText], navigate }) {
  const id = Number(idText);
  mount(container, skeleton(2));
  let run = await api.get(`runs/${id}`);
  const viewer = logViewer(id, () => run);
  const body = h('div', { class: 'stack' });

  function paint() {
    const totals = run.summary?.totals;
    const cancel = async (event) => busy(event.currentTarget, async () => {
      try {
        await api.post(`runs/${id}/cancel`);
      } catch (error) {
        reportError(error);
      }
    });
    const again = async (event) => busy(event.currentTarget, async () => {
      try {
        const { run: next } = await api.post('runs', { connectionId: run.connectionId, repositories: run.scope, dryRun: run.dryRun });
        toast(t('overview.run_started'));
        navigate(`/runs/${next.id}`);
      } catch (error) {
        reportError(error);
      }
    });
    const diagnosis = run.status === 'failed' || run.error === 'no_repositories' ? run.error : null;
    mount(body,
      h('div', { class: 'page-head' },
        h('div', {}, h('h1', {}, t('runs.detail_title', { id: run.id })), h('p', {}, `${run.connectionName} · ${triggerName(run.trigger)} · ${dateTime(run.startedAt ?? run.queuedAt)}`)),
        h('div', { class: 'row' }, runBadge(run), run.dryRun ? badge(t('runs.preview_badge'), 'accent') : null,
          isActive(run) ? h('button', { class: 'btn danger', type: 'button', onclick: cancel }, iconStop(), t('runs.cancel')) : run.connectionId ? h('button', { class: 'btn', type: 'button', onclick: again }, iconRefresh(), t('runs.again')) : null)),
      diagnosis ? notice(run.error === 'no_repositories' ? 'info' : 'danger', hasText(`diagnosis.${diagnosis}`) ? t(`diagnosis.${diagnosis}`) : diagnosis) : null,
      totals ? h('div', { class: 'tiles' },
        [['repositories', totals.repositories], ['prsCreated', totals.prsCreated], ['prsUpdated', totals.prsUpdated], ['pending', totals.pending], ['errors', totals.errors]].map(([key, value]) => h('div', { class: 'tile' }, h('div', { class: 'value' }, number(value)), h('div', { class: 'label' }, t(`runs.tile.${key}`)))),
        h('div', { class: 'tile' }, h('div', { class: 'value' }, duration(run.startedAt, run.finishedAt)), h('div', { class: 'label' }, t('runs.col.duration')))) : null,
      run.summary && Object.keys(run.summary.repositories).length
        ? h('section', { class: 'stack' }, h('h2', {}, t('runs.repositories')), Object.entries(run.summary.repositories).map(([name, result]) => repositoryResult(name, result)))
        : null);
  }

  mount(container, body, viewer.element);
  paint();
  await viewer.reload();
  const stopPolling = poll(async () => {
    const before = run.status;
    run = await api.get(`runs/${id}`);
    if (before !== run.status) {
      paint();
      if (!isActive(run)) viewer.close();
    }
  }, () => (isActive(run) ? 2500 : 600_000));
  return () => {
    stopPolling();
    viewer.close();
  };
}
