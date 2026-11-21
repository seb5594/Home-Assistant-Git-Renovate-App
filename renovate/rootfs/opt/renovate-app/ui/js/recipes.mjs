// Ready-made answers to "which updates should merge by themselves?". A recipe is only a set of values for
// the settings of the group "updates", so everything it does can be seen and changed under Settings.
import { api } from './api.mjs';
import { badge, reportError, toast } from './components.mjs';
import { EMOJI, emoji } from './emoji.mjs';
import { h } from './dom.mjs';
import { t } from './i18n.mjs';

export const RECIPES = [
  { id: 'careful', values: { 'updates.major': 'pr', 'updates.minor': 'pr', 'updates.patch': 'pr', 'updates.group_non_major': false, 'updates.minimum_age_days': 0 } },
  { id: 'balanced', recommended: true, values: { 'updates.major': 'pr', 'updates.minor': 'automerge', 'updates.patch': 'automerge', 'updates.group_non_major': false, 'updates.minimum_age_days': 3 } },
  { id: 'quiet', values: { 'updates.major': 'approval', 'updates.minor': 'automerge', 'updates.patch': 'automerge', 'updates.group_non_major': true, 'updates.minimum_age_days': 3 } },
  { id: 'hands_off', values: { 'updates.major': 'automerge', 'updates.minor': 'automerge', 'updates.patch': 'automerge', 'updates.group_non_major': false, 'updates.minimum_age_days': 3 } },
];

const isCurrent = (recipe, current) => Object.entries(recipe.values).every(([key, value]) => current.get(key) === value);

/**
 * The cards of all recipes with the one in use marked. Loads the settings itself and repaints after a choice,
 * so any view can show it. `onApplied` lets the caller refresh what it shows next to it.
 */
export function recipePicker({ onApplied } = {}) {
  const wrap = h('div', { class: 'recipes' });

  async function paint() {
    const { settings } = await api.get('settings');
    const current = new Map(settings.map((entry) => [entry.key, entry.value]));
    const locked = settings.some((entry) => entry.key.startsWith('updates.') && entry.locked);
    wrap.replaceChildren(...RECIPES.map((recipe) => {
      const active = isCurrent(recipe, current);
      return h('div', { class: ['recipe', active && 'active'] },
        h('div', { class: 'row' }, h('strong', {}, emoji(EMOJI.recipe[recipe.id]), t(`recipe.${recipe.id}.name`)),
          recipe.recommended ? badge(t('recipe.recommended'), 'accent') : null, active ? badge(t('recipe.in_use'), 'ok') : null),
        h('p', { class: 'muted small' }, t(`recipe.${recipe.id}.text`)),
        h('ul', { class: 'small recipe-rules' }, ['major', 'minor', 'patch'].map((kind) => h('li', {}, emoji(EMOJI.action[recipe.values[`updates.${kind}`]]), `${t(`recipe.kind.${kind}`)}: `, t(`settings.updates.action.${recipe.values[`updates.${kind}`]}`)))),
        h('button', { class: ['btn', 'small', active ? '' : 'outline'], type: 'button', disabled: active || locked, title: locked ? t('recipe.locked') : null, onclick: () => apply(recipe) }, t('recipe.use')));
    }));
  }

  async function apply(recipe) {
    try {
      await api.put('settings', { changes: recipe.values });
      toast(t('recipe.applied', { name: t(`recipe.${recipe.id}.name`) }));
      await paint();
      await onApplied?.();
    } catch (error) {
      reportError(error);
    }
  }

  paint().catch(reportError);
  return wrap;
}
