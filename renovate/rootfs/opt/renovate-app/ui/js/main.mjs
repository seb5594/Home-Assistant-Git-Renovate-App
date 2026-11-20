// Starts the interface: language and theme, the shell (navigation, status, footer) and the hash router.
import { api } from './api.mjs';
import { toast, errorText } from './components.mjs';
import { h, mount } from './dom.mjs';
import { renderFooter } from './footer.mjs';
import { homeAssistantLanguage, applyTheme, watchTheme } from './theme.mjs';
import { setLanguage, t } from './i18n.mjs';
import { poll } from './poll.mjs';
import { badge } from './components.mjs';
import { connectionDetail, connectionsList } from './views/connections.mjs';
import { overview } from './views/overview.mjs';
import { runDetail, runsList } from './views/runs.mjs';
import { settingsView } from './views/settings.mjs';
import { wizard } from './views/wizard.mjs';

const ROUTES = [
  { pattern: /^\/?$/, view: overview, nav: 'overview' },
  { pattern: /^\/connections$/, view: connectionsList, nav: 'connections' },
  { pattern: /^\/connections\/([^/]+)$/, view: connectionDetail, nav: 'connections' },
  { pattern: /^\/connect$/, view: wizard, nav: 'connections' },
  { pattern: /^\/runs$/, view: runsList, nav: 'runs' },
  { pattern: /^\/runs\/(\d+)$/, view: runDetail, nav: 'runs' },
  { pattern: /^\/settings$/, view: settingsView, nav: 'settings' },
];
const NAV = ['overview', 'connections', 'runs', 'settings'];

const root = document.getElementById('app');
let boot;
let dispose = null;
let stopStatusPolling = null;

const navigate = (path) => {
  window.location.hash = `#${path}`;
};

async function loadBoot() {
  boot = await api.get('boot');
  const requested = boot.general.language;
  await setLanguage(requested === 'auto' ? (homeAssistantLanguage() ?? navigator.language) : requested);
  applyTheme(boot.general);
  document.title = `${t('app.name')} · Home Assistant`;
}

function renderShell() {
  const nav = h('nav', { class: 'nav', aria: { label: t('nav.label') } },
    NAV.map((key) => h('a', { href: key === 'overview' ? '#/' : `#/${key}`, dataset: { nav: key } }, t(`nav.${key}`))));
  const chip = h('div', { class: 'status-chip', id: 'status-chip' });
  const main = h('main', { id: 'view', tabindex: '-1' });
  mount(root,
    h('header', { class: 'topbar' }, h('div', { class: 'topbar-inner' },
      h('a', { class: 'brand', href: '#/' }, h('img', { src: 'assets/icon.svg', alt: '' }), h('span', {}, t('app.name'))), nav, chip)),
    main,
    renderFooter({ appVersion: boot.version, software: { name: 'Renovate', ...boot.renovate }, t }));
  return main;
}

async function refreshChip() {
  const chip = document.getElementById('status-chip');
  if (!chip) return;
  const status = await api.get('status');
  const running = status.running.length;
  const state = running
    ? badge(t('chip.running', { count: running }), 'accent', { running: true })
    : status.queued ? badge(t('chip.queued', { count: status.queued }), '') : badge(t('chip.idle'), 'ok');
  const restart = status.configuration?.restartRequired ? badge(t('chip.restart'), 'warn') : null;
  restart?.setAttribute('title', t('chip.restart_hint'));
  mount(chip, h('span', { class: 'row' }, restart, state));
}

async function route() {
  dispose?.();
  dispose = null;
  const path = window.location.hash.replace(/^#/, '') || '/';
  const [pathname, search = ''] = path.split('?');
  const match = ROUTES.map((entry) => ({ entry, found: entry.pattern.exec(pathname) })).find((candidate) => candidate.found);
  const container = document.getElementById('view');
  for (const link of document.querySelectorAll('.nav a')) {
    if (link.dataset.nav === match?.entry.nav) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (!match) return navigate('/');
  const context = {
    boot,
    navigate,
    params: match.found.slice(1),
    query: new URLSearchParams(search),
    refreshChip,
    reloadBoot: async () => {
      await loadBoot();
      renderApp();
    },
  };
  try {
    dispose = (await match.entry.view(container, context)) ?? null;
  } catch (error) {
    mount(container, h('div', { class: 'notice danger', role: 'alert' }, errorText(error)));
  }
  window.scrollTo({ top: 0 });
}

function renderApp() {
  renderShell();
  stopStatusPolling?.();
  stopStatusPolling = poll(refreshChip, () => 8000);
  refreshChip().catch(() => {});
  route();
}

async function start() {
  try {
    await loadBoot();
  } catch (error) {
    await setLanguage(navigator.language).catch(() => {});
    mount(root, h('main', {}, h('div', { class: 'notice danger', role: 'alert' }, `${t('error.unreachable')} ${error.message}`)));
    return;
  }
  renderApp();
  window.addEventListener('hashchange', route);
  watchTheme(() => boot && applyTheme(boot.general));
  window.addEventListener('unhandledrejection', (event) => toast(errorText(event.reason), { error: true }));
}

start();
