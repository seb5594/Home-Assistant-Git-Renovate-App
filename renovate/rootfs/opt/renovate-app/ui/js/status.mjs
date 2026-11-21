// How runs and providers are named and colored, in one place so every view agrees.
import { badge } from './components.mjs';
import { EMOJI } from './emoji.mjs';
import { t } from './i18n.mjs';

const RUN_SYMBOLS = { queued: '⏳', running: '', succeeded: EMOJI.status.ok, failed: EMOJI.status.danger, cancelled: '🚫', interrupted: EMOJI.status.warn };
const RUN_TONES = { queued: '', running: 'accent', succeeded: 'ok', failed: 'danger', cancelled: 'warn', interrupted: 'warn' };

/** The badge of a run; a succeeded run with errors in some repositories is shown as a warning. */
export function runBadge(run) {
  const errors = run.summary?.totals?.errors ?? 0;
  if (run.status === 'succeeded' && errors > 0) return badge(`${EMOJI.status.warn} ${t('run.status.problems')}`, 'warn');
  return badge(`${RUN_SYMBOLS[run.status] ?? ''} ${t(`run.status.${run.status}`)}`.trim(), RUN_TONES[run.status] ?? '', { running: run.status === 'running' });
}

export const providerName = (id) => ({ github: 'GitHub', gitlab: 'GitLab', gitea: 'Gitea', forgejo: 'Forgejo', bitbucket: 'Bitbucket Cloud', 'bitbucket-server': 'Bitbucket Server', azure: 'Azure DevOps', gerrit: 'Gerrit', 'scm-manager': 'SCM-Manager' })[id] ?? id;

export const triggerName = (trigger) => t(`run.trigger.${trigger}`);

export const isActive = (run) => run.status === 'queued' || run.status === 'running';
