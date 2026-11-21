// The emojis of the interface, in one place so every view uses the same picture for the same thing.
// They are decoration: screen readers skip them (aria-hidden) and no text depends on them.
import { h } from './dom.mjs';

export const EMOJI = {
  nav: { overview: '🏠', connections: '🔌', runs: '🏃', guide: '📖', settings: '⚙️' },
  group: { renovate: '🤖', updates: '🔀', history: '🕘', resources: '🧠', schedule: '⏰', webhooks: '🪝', home_assistant: '🏡', general: '🎨', advanced: '🛠️' },
  provider: { github: '🐙', gitlab: '🦊', gitea: '🍵', forgejo: '🌿', bitbucket: '🪣', 'bitbucket-server': '🗄️', azure: '☁️', gerrit: '🔎', 'scm-manager': '📦' },
  action: { repository: '📁', pr: '🔀', approval: '🙋', automerge: '✅', ignore: '⏭️' },
  recipe: { careful: '🛡️', balanced: '⚖️', quiet: '🌙', hands_off: '🚀' },
  tile: { open_prs: '🔀', repositories: '📚', last_run: '🏁', next_run: '⏰' },
  branch: {
    'pr-created': '🆕', rebase: '🔄', 'already-existed': '👍', automerged: '✅', done: '✔️', 'no-work': '😴', error: '❌',
    'pr-edited': '✋', 'needs-approval': '🙋', 'needs-pr-approval': '🙋', 'not-scheduled': '🗓️', 'update-not-scheduled': '🗓️', pending: '⏳',
    'pr-limit-reached': '🚦', 'branch-limit-reached': '🚦', 'commit-hourly-limit-reached': '🚦', 'commit-per-run-limit-reached': '🚦', 'minimum-group-size-not-met': '🧺',
  },
  status: { ok: '✅', warn: '⚠️', danger: '❌', info: 'ℹ️', tip: '💡' },
};

/** An emoji as an element, for places that build nodes. */
export const emoji = (symbol) => h('span', { class: 'emoji', aria: { hidden: 'true' } }, symbol);

/** An emoji in front of a text, for places that only take text (options of a select, for example). */
export const withEmoji = (symbol, text) => (symbol ? `${symbol} ${text}` : text);
