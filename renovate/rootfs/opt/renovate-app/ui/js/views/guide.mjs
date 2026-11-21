// The guide: how to get Renovate to do what you want, written for someone who has never used it.
// Texts live in the locale files (guide.*); text between `backticks` is shown as code.
import { toast, notice } from '../components.mjs';
import { h, mount } from '../dom.mjs';
import { EMOJI, emoji } from '../emoji.mjs';
import { t } from '../i18n.mjs';
import { recipePicker } from '../recipes.mjs';

const MINIMAL_CONFIG = `{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended"]
}`;

const EXCEPTION_CONFIG = `{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended"],
  "packageRules": [
    { "matchPackageNames": ["react"], "matchUpdateTypes": ["major"], "enabled": false },
    { "matchManagers": ["github-actions"], "automerge": true }
  ]
}`;

/** Text with `code` spans, built as nodes so nothing is ever interpreted as HTML. */
const rich = (text) => text.split('`').map((part, index) => (index % 2 ? h('code', {}, part) : part));

const paragraph = (key, params) => h('p', {}, rich(t(key, params)));
const list = (tag, keys) => h(tag, { class: 'guide-list' }, keys.map((key) => h('li', {}, rich(t(key)))));

function codeBlock(text) {
  return h('div', { class: 'code-block' },
    h('pre', {}, h('code', {}, text)),
    h('button', { class: 'btn small', type: 'button', onclick: async () => { await navigator.clipboard?.writeText(text).catch(() => {}); toast(t('common.copied')); } }, t('common.copy')));
}

const tip = (key) => notice('info', h('div', {}, rich(t(key))));

const SECTIONS = [
  { id: 'start', symbol: '🚀', open: true,
    body: () => [list('ol', ['guide.start.step1', 'guide.start.step2', 'guide.start.step3', 'guide.start.step4']), paragraph('guide.start.onboarding')] },
  { id: 'recipes', symbol: '🔀', open: true,
    body: () => [paragraph('guide.recipes.intro'), list('ul', ['guide.recipes.repository', 'guide.recipes.pr', 'guide.recipes.approval', 'guide.recipes.automerge', 'guide.recipes.ignore']),
      recipePicker(), paragraph('guide.recipes.where'), tip('guide.recipes.checks'), paragraph('guide.recipes.exceptions'), codeBlock(EXCEPTION_CONFIG)] },
  { id: 'account', symbol: '🤖',
    body: () => [paragraph('guide.account.intro'), list('ol', ['guide.account.step1', 'guide.account.step2', 'guide.account.step3', 'guide.account.step4']), tip('guide.account.note')] },
  { id: 'token', symbol: '🔑',
    body: () => [paragraph('guide.token.intro'), list('ul', ['guide.token.github', 'guide.token.github_classic', 'guide.token.gitlab', 'guide.token.gitea', 'guide.token.others']), tip('guide.token.symptom')] },
  { id: 'config', symbol: '📄',
    body: () => [paragraph('guide.config.intro'), list('ul', ['guide.config.files', 'guide.config.onboarding', 'guide.config.presets']), codeBlock(MINIMAL_CONFIG), paragraph('guide.config.more')] },
  { id: 'mend', symbol: '🔁',
    body: () => [paragraph('guide.mend.intro'), list('ul', ['guide.mend.uninstall', 'guide.mend.edited', 'guide.mend.config', 'guide.mend.onboarding'])] },
  { id: 'nothing', symbol: '🕵️',
    body: () => [paragraph('guide.nothing.intro'), list('ol', ['guide.nothing.step1', 'guide.nothing.step2', 'guide.nothing.step3', 'guide.nothing.step4', 'guide.nothing.step5', 'guide.nothing.step6', 'guide.nothing.step7'])] },
];

export async function guideView(container) {
  const sections = SECTIONS.map((section) => h('details', { class: 'card guide-section', id: `guide-${section.id}`, open: section.open },
    h('summary', {}, h('h2', {}, emoji(section.symbol), t(`guide.${section.id}.title`))),
    h('div', { class: 'stack' }, ...section.body())));

  const jump = (id) => {
    const target = sections.find((element) => element.id === `guide-${id}`);
    target.open = true;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  mount(container,
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, emoji(EMOJI.nav.guide), t('guide.title')), h('p', {}, t('guide.subtitle')))),
    h('div', { class: 'row chips', role: 'navigation', aria: { label: t('guide.contents') } },
      SECTIONS.map((section) => h('button', { class: 'chip', type: 'button', onclick: () => jump(section.id) }, emoji(section.symbol), t(`guide.${section.id}.title`)))),
    sections);
}
