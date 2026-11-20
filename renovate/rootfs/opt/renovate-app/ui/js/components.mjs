// Small building blocks shared by the views: toasts, confirmation dialogs, switches, badges, notices.
import { h, mount } from './dom.mjs';
import { iconInfo, iconWarning, iconCheck } from './icons.mjs';
import { t } from './i18n.mjs';

export function toast(message, { error = false } = {}) {
  const container = document.getElementById('toasts');
  const element = h('div', { class: ['toast', error && 'error'] }, message);
  container.append(element);
  setTimeout(() => element.remove(), error ? 7000 : 3500);
}

/** Shows the message of an error as a toast; used as the catch handler of user actions. */
export function reportError(error) {
  toast(errorText(error), { error: true });
}

/** Turns an API error into a sentence in the user's language when the code is known. */
export function errorText(error) {
  const key = `error.${error?.code}`;
  const translated = t(key);
  return translated === key ? (error?.message ?? String(error)) : translated;
}

/** @returns {Promise<boolean>} true when the user confirmed */
export function confirmDialog({ title, message, confirmLabel, danger = false }) {
  return new Promise((resolve) => {
    const dialog = h('dialog', { aria: { labelledby: 'dialog-title' } },
      h('h2', { id: 'dialog-title' }, title),
      h('p', { class: 'muted' }, message),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => dialog.close('cancel') }, t('common.cancel')),
        h('button', { class: ['btn', danger ? 'danger' : 'primary'], type: 'button', onclick: () => dialog.close('confirm') }, confirmLabel ?? t('common.confirm'))));
    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue === 'confirm');
      dialog.remove();
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

export function switchControl({ checked, disabled = false, label, onchange }) {
  const input = h('input', { type: 'checkbox', role: 'switch', checked, disabled, aria: { label }, onchange: () => onchange?.(input.checked) });
  return h('span', { class: 'switch' }, input, h('span', { class: 'track' }));
}

export function badge(text, tone = '', { running = false } = {}) {
  return h('span', { class: ['badge', tone, running && 'running'] }, running ? h('span', { class: 'dot' }) : null, text);
}

const NOTICE_ICONS = { warn: iconWarning, danger: iconWarning, ok: iconCheck, info: iconInfo };

export function notice(tone, ...content) {
  return h('div', { class: ['notice', tone === 'info' ? '' : tone], role: tone === 'danger' ? 'alert' : null },
    (NOTICE_ICONS[tone] ?? iconInfo)(), h('div', { class: 'stack' }, ...content));
}

/** The warning shown when entries of the app configuration could not be applied; null when all is well. */
export function configurationNotice(configuration) {
  if (!configuration?.problems?.length) return null;
  return notice('warn',
    h('strong', {}, t('config.problems_title')),
    h('div', {}, t('config.problems_text')),
    h('ul', {}, configuration.problems.map((problem) => h('li', {}, h('strong', {}, problem.name), `: ${problem.message}`))));
}

export function avatar(connection) {
  const initial = (connection.accountName || connection.accountLogin || connection.name || '?').slice(0, 1).toUpperCase();
  return h('span', { class: 'avatar', aria: { hidden: true } },
    connection.hasAvatar ? h('img', { src: `api/connections/${connection.id}/avatar`, alt: '', loading: 'lazy', onerror: (event) => event.target.replaceWith(initial) }) : initial);
}

export function skeleton(count = 3) {
  return h('div', { class: 'stack' }, Array.from({ length: count }, () => h('div', { class: 'skeleton' })));
}

export function emptyState(title, text, ...actions) {
  return h('div', { class: 'card hero' }, h('h2', {}, title), h('p', {}, text), h('div', { class: 'row' }, ...actions));
}

/** Runs an async action while a button is disabled, so a double click cannot start it twice. */
export async function busy(button, work) {
  button.disabled = true;
  try {
    return await work();
  } finally {
    button.disabled = false;
  }
}

export { mount };
