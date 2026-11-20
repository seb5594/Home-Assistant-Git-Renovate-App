// The settings page is generated from the definitions the server sends (server/settings/registry.mjs), so a new
// setting needs no interface code, only its texts in the locale files.
import { api } from '../api.mjs';
import { badge, busy, configurationNotice, confirmDialog, notice, reportError, skeleton, switchControl, toast } from '../components.mjs';
import { h, mount } from '../dom.mjs';
import { iconLock, iconPlus, iconRefresh, iconTrash } from '../icons.mjs';
import { dateTime } from '../format.mjs';
import { hasText, t } from '../i18n.mjs';

const SAVE_DELAY_MS = 700;

const label = (key) => t(`settings.${key}.label`);
const optionLabel = (key, value) => (hasText(`settings.${key}.${value}`) ? t(`settings.${key}.${value}`) : value);

export async function settingsView(container, context) {
  mount(container, skeleton(3));
  let data = await api.get('settings');
  let configuration = (await api.get('status')).configuration;
  const timers = new Map();
  // The box that shows which resource profile is in effect. It is replaced after every change, because a
  // changed profile or limit changes what the box says, while the form itself must not be redrawn under the cursor.
  let resourcesBox = null;

  async function save(key, value, { reload = false } = {}) {
    try {
      data = { ...data, ...(await api.put('settings', { changes: { [key]: value } })) };
      toast(t('common.saved'));
      if (resourcesBox) {
        const next = resourcesInfo();
        resourcesBox.replaceWith(next);
        resourcesBox = next;
      }
      if (key.startsWith('general.')) await context.reloadBoot();
      else if (reload) paint();
    } catch (error) {
      reportError(error);
      data = await api.get('settings');
      paint();
    }
  }

  const later = (key, value) => {
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => save(key, value), SAVE_DELAY_MS));
  };

  function control(entry) {
    const disabled = entry.locked;
    switch (entry.type) {
      case 'bool':
        return switchControl({ checked: Boolean(entry.value), disabled, label: label(entry.key), onchange: (checked) => save(entry.key, checked) });
      case 'enum':
        return h('select', { disabled, 'aria-label': label(entry.key), onchange: (event) => save(entry.key, event.target.value) },
          entry.values.map((value) => h('option', { value, selected: entry.value === value }, optionLabel(entry.key, value))));
      case 'int':
        return h('input', { type: 'number', min: entry.min, max: entry.max, value: entry.value ?? '', placeholder: entry.default ?? t('settings.automatic'), disabled, 'aria-label': label(entry.key),
          oninput: (event) => (event.target.value === '' ? later(entry.key, null) : later(entry.key, Number(event.target.value))) });
      case 'secret':
        return h('div', { class: 'row' },
          h('input', { type: 'password', autocomplete: 'new-password', disabled, placeholder: entry.configured ? '••••••••' : '', 'aria-label': label(entry.key), onchange: (event) => event.target.value && save(entry.key, event.target.value, { reload: true }) }),
          entry.configured && !disabled ? h('button', { class: 'btn small ghost', type: 'button', onclick: () => save(entry.key, null, { reload: true }) }, t('settings.remove_secret')) : null);
      case 'list':
        return h('textarea', { rows: '3', disabled, 'aria-label': label(entry.key), placeholder: t('settings.one_per_line'), oninput: (event) => later(entry.key, event.target.value.split('\n').map((line) => line.trim()).filter(Boolean)) }, (entry.value ?? []).join('\n'));
      case 'records':
        return recordsEditor(entry, disabled);
      default: {
        const input = h('input', { type: entry.type === 'url' ? 'url' : 'text', value: entry.value ?? '', placeholder: entry.default ?? entry.patternHint ?? '', disabled, 'aria-label': label(entry.key), autocomplete: 'off',
          oninput: (event) => later(entry.key, event.target.value.trim() === '' ? null : event.target.value.trim()) });
        if (entry.key !== 'general.accent_color') return input;
        const picker = h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(entry.value ?? '') ? entry.value : '#2563eb', disabled, 'aria-label': label(entry.key), onchange: (event) => { input.value = event.target.value; save(entry.key, event.target.value); } });
        return h('div', { class: 'row' }, picker, input);
      }
    }
  }

  function recordsEditor(entry, disabled) {
    let rows = (entry.value ?? []).map((row) => ({ ...row }));
    const wrap = h('div', { class: 'records' });
    const commit = () => later(entry.key, rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !key.endsWith('_set')))));
    function paintRows() {
      mount(wrap, rows.map((row, index) => h('div', { class: 'record' },
        entry.fields.map((field) => h('input', {
          type: field.type === 'secret' ? 'password' : 'text', disabled, autocomplete: 'off', value: field.type === 'secret' ? '' : (row[field.key] ?? ''),
          placeholder: field.type === 'secret' && row[`${field.key}_set`] ? t('settings.unchanged') : t(`settings.${entry.key}.field.${field.key}`),
          'aria-label': t(`settings.${entry.key}.field.${field.key}`),
          oninput: (event) => { row[field.key] = event.target.value; commit(); },
        })),
        disabled ? null : h('button', { class: 'btn small ghost', type: 'button', 'aria-label': t('common.remove'), onclick: () => { rows.splice(index, 1); paintRows(); commit(); } }, iconTrash()))),
      disabled ? null : h('button', { class: 'btn small', type: 'button', onclick: () => { rows.push({}); paintRows(); } }, iconPlus(), t('settings.add_row')));
    }
    paintRows();
    return wrap;
  }

  function item(entry) {
    const helpKey = `settings.${entry.key}.help`;
    return h('div', { class: 'setting' },
      h('div', {},
        h('div', { class: 'name' }, label(entry.key),
          entry.locked ? h('span', { class: 'badge', title: t(`settings.locked.${entry.lockReason}`) }, iconLock(), t(`settings.locked.${entry.lockReason}`)) : null,
          entry.optionError ? badge(t('settings.option_invalid'), 'warn') : null),
        hasText(helpKey) ? h('div', { class: 'hint' }, t(helpKey)) : null,
        entry.optionError ? h('div', { class: 'hint' }, entry.optionError) : null),
      h('div', { class: 'control' }, control(entry),
        entry.source === 'ui' ? h('button', { class: 'btn small ghost', type: 'button', onclick: () => save(entry.key, null, { reload: true }) }, t('settings.reset')) : null));
  }

  function resourcesInfo() {
    const { resources, machine } = data;
    return notice('info', h('div', {}, h('strong', {}, t('settings.resources.profile', { profile: t(`settings.resources.profile.${resources.profile}`) })), resources.automatic ? ` (${t('settings.resources.automatic')})` : ''),
      h('div', { class: 'small' }, t('settings.resources.limits', { runs: resources.maxConcurrentRuns, memory: resources.memoryLimitMb, batch: resources.batchSize, priority: resources.cpuPriority })),
      h('div', { class: 'small muted' }, t('settings.resources.machine', { memory: machine.totalMemoryMb, cpus: machine.cpus })));
  }

  function group(name) {
    const entries = data.settings.filter((entry) => entry.group === name);
    const basic = entries.filter((entry) => !entry.advanced);
    const advanced = entries.filter((entry) => entry.advanced);
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, t(`settings.group.${name}`))),
      h('p', { class: 'muted' }, t(`settings.group.${name}.help`)),
      name === 'resources' ? (resourcesBox = resourcesInfo()) : null,
      basic.map(item),
      advanced.length ? h('details', { class: 'advanced' }, h('summary', {}, t('settings.advanced')), advanced.map(item)) : null);
  }

  const configurationCard = () => h('section', { class: 'card stack' },
    h('h2', {}, t('settings.config.title')),
    h('p', { class: 'muted' }, t('settings.config.text')),
    configurationNotice(configuration),
    h('div', { class: 'row' },
      h('button', { class: 'btn', type: 'button', onclick: async (event) => busy(event.currentTarget, async () => {
        try {
          const result = await api.post('configuration/reload');
          configuration = result.configuration;
          data = await api.get('settings');
          toast(t(result.changed ? 'settings.config.reloaded' : 'settings.config.unchanged'));
          paint();
        } catch (error) {
          reportError(error);
        }
      }) }, iconRefresh(), t('settings.config.reload')),
      configuration.syncedAt ? h('span', { class: 'muted small' }, t('settings.config.synced', { when: dateTime(configuration.syncedAt) })) : null));

  const maintenance = () => h('section', { class: 'card stack' }, h('h2', {}, t('settings.maintenance.title')), h('p', { class: 'muted' }, t('settings.maintenance.text')),
    h('div', { class: 'row' },
      h('button', { class: 'btn', type: 'button', onclick: async (event) => busy(event.currentTarget, async () => {
        if (!(await confirmDialog({ title: t('settings.maintenance.clear_cache'), message: t('settings.maintenance.clear_cache_text'), confirmLabel: t('settings.maintenance.clear_cache') }))) return;
        try {
          await api.post('maintenance/clear-cache');
          toast(t('settings.maintenance.cache_cleared'));
        } catch (error) {
          reportError(error);
        }
      }) }, t('settings.maintenance.clear_cache')),
      h('button', { class: 'btn', type: 'button', onclick: async (event) => busy(event.currentTarget, async () => {
        try {
          const { removed } = await api.post('maintenance/prune');
          toast(t('settings.maintenance.pruned', { count: removed }));
        } catch (error) {
          reportError(error);
        }
      }) }, t('settings.maintenance.prune'))));

  function paint() {
    mount(container,
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, t('settings.title')), h('p', {}, t('settings.subtitle')))),
      notice('info', t('settings.how_it_works')),
      configurationCard(),
      data.groups.map(group), maintenance());
  }

  paint();
  return () => { for (const timer of timers.values()) clearTimeout(timer); };
}
