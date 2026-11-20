// The setup assistant: pick a server, sign in the easiest way that server allows, choose repositories, first run.
import { api } from '../api.mjs';
import { badge, busy, errorText, notice, reportError, toast } from '../components.mjs';
import { h, mount } from '../dom.mjs';
import { iconExternal, iconPlay } from '../icons.mjs';
import { t } from '../i18n.mjs';
import { providerName } from '../status.mjs';
import { repositoriesTab } from './connections.mjs';

const STEPS = ['server', 'connect', 'repositories', 'done'];
const SELF_HOSTED_ONLY = ['gitea', 'forgejo'];

export async function wizard(container, { boot, navigate }) {
  const state = { step: 0, provider: null, selfHosted: false, endpoint: '', method: null, verified: null, connection: null, discovered: [] };
  let pollTimer = null;

  const stop = () => clearTimeout(pollTimer);
  const providerInfo = () => boot.providers.find((provider) => provider.id === state.provider);
  const needsAddress = () => SELF_HOSTED_ONLY.includes(state.provider) || state.selfHosted;

  function frame(...content) {
    mount(container,
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, t('wizard.title')), h('p', {}, t('wizard.subtitle'))),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => navigate(state.connection ? `/connections/${state.connection.id}` : '/') }, t('common.cancel'))),
      h('ol', { class: 'stepper', 'aria-label': t('wizard.steps') }, STEPS.map((key, index) => h('li', { class: index < state.step ? 'done' : '', ...(index === state.step ? { 'aria-current': 'step' } : {}) }, t(`wizard.step.${key}`)))),
      ...content);
  }

  // --- step 1 ------------------------------------------------------------------------------------------
  function chooseServer() {
    state.step = 0;
    frame(h('div', { class: 'provider-grid' }, boot.providers.map((provider) => h('button', { class: 'provider-card', type: 'button', onclick: () => select(provider.id) },
      h('strong', {}, provider.label), h('span', { class: 'muted small' }, t(`wizard.provider.${provider.id}`)),
      provider.deviceFlow ? badge(t('wizard.badge.code'), 'accent') : provider.credentialLogin ? badge(t('wizard.badge.password'), 'accent') : badge(t('wizard.badge.token'))))));
  }

  async function select(provider) {
    state.provider = provider;
    state.selfHosted = false;
    state.endpoint = '';
    state.verified = null;
    state.method = providerInfo().deviceFlow ? 'device' : providerInfo().credentialLogin ? 'password' : 'token';
    state.discovered = [];
    connectStep();
    if (SELF_HOSTED_ONLY.includes(provider)) {
      try {
        state.discovered = (await api.post('connect/discover')).found;
        if (state.discovered.length && !state.endpoint) state.endpoint = state.discovered[0].url;
        if (state.step === 1) connectStep();
      } catch {
        // Discovery is a convenience only.
      }
    }
  }

  // --- step 2 ------------------------------------------------------------------------------------------
  function addressField() {
    if (!needsAddress()) {
      return providerInfo().id === 'github' || providerInfo().id === 'gitlab'
        ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: state.selfHosted, onchange: (event) => { state.selfHosted = event.target.checked; connectStep(); } }),
          h('span', {}, t(`wizard.self_hosted.${state.provider}`)))
        : null;
    }
    const input = h('input', { type: 'url', value: state.endpoint, placeholder: t(`wizard.address.placeholder.${state.provider}`), autocomplete: 'off', oninput: (event) => { state.endpoint = event.target.value.trim(); } });
    return h('div', { class: 'stack' },
      h('label', { class: 'field' }, t('wizard.address'), input, h('span', { class: 'hint' }, t('wizard.address_hint'))),
      state.discovered.length ? notice('ok', h('div', {}, t('wizard.discovered', { url: state.discovered[0].url, version: state.discovered[0].version })),
        h('div', {}, h('button', { class: 'btn small', type: 'button', onclick: () => { state.endpoint = state.discovered[0].url; input.value = state.endpoint; } }, t('wizard.use_found')))) : null,
      !SELF_HOSTED_ONLY.includes(state.provider) ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: true, onchange: (event) => { state.selfHosted = event.target.checked; connectStep(); } }), h('span', {}, t(`wizard.self_hosted.${state.provider}`))) : null);
  }

  function methodTabs() {
    const methods = [];
    if (providerInfo().deviceFlow) methods.push('device');
    if (providerInfo().credentialLogin) methods.push('password');
    methods.push('token');
    if (methods.length === 1) return null;
    return h('div', { class: 'tabs', role: 'tablist' }, methods.map((method) => h('button', { type: 'button', role: 'tab', aria: { selected: String(state.method === method) }, onclick: () => { stop(); state.method = method; connectStep(); } }, t(`wizard.method.${method}`))));
  }

  const endpointForRequest = () => (needsAddress() ? state.endpoint : '');

  async function verified(result) {
    state.verified = result;
    connectStep();
  }

  function tokenMethod() {
    const input = h('input', { type: 'password', autocomplete: 'off', placeholder: t('wizard.token.placeholder') });
    const guide = h('div', { class: 'stack' });
    const loadGuide = async () => {
      try {
        const info = await api.get(`connect/guide?provider=${state.provider}&endpoint=${encodeURIComponent(endpointForRequest())}`);
        mount(guide,
          h('ol', { class: 'ordered' },
            h('li', {}, t(`wizard.token.step1.${state.provider}`)),
            h('li', {}, t('wizard.token.step2', { scopes: info.scopes.join(', ') })),
            h('li', {}, t('wizard.token.step3'))),
          h('div', { class: 'row' },
            h('a', { class: 'btn outline', href: info.url, target: '_blank', rel: 'noopener noreferrer' }, iconExternal(), t('wizard.token.create', { name: providerName(state.provider) })),
            info.alternativeUrl ? h('a', { class: 'small', href: info.alternativeUrl, target: '_blank', rel: 'noopener noreferrer' }, t('wizard.token.fine_grained')) : null));
      } catch (error) {
        mount(guide, h('p', { class: 'muted' }, errorText(error)));
      }
    };
    loadGuide();
    return h('div', { class: 'stack' }, guide,
      h('label', { class: 'field' }, t('wizard.token.label'), input),
      h('div', {}, h('button', { class: 'btn primary', type: 'button', onclick: (event) => busy(event.currentTarget, async () => {
        try {
          await verified(await api.post('connect/verify', { provider: state.provider, endpoint: endpointForRequest(), token: input.value.trim() }));
        } catch (error) {
          reportError(error);
        }
      }) }, t('wizard.check'))));
  }

  function passwordMethod() {
    const user = h('input', { type: 'text', autocomplete: 'username', placeholder: t('wizard.password.user') });
    const pass = h('input', { type: 'password', autocomplete: 'current-password', placeholder: t('wizard.password.password') });
    const otp = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '123456' });
    const otpField = h('label', { class: 'field', hidden: true }, t('wizard.password.otp'), otp);
    return h('div', { class: 'stack' }, notice('info', t('wizard.password.explain', { name: providerName(state.provider) })),
      h('label', { class: 'field' }, t('wizard.password.user'), user), h('label', { class: 'field' }, t('wizard.password.password'), pass), otpField,
      h('div', {}, h('button', { class: 'btn primary', type: 'button', onclick: (event) => busy(event.currentTarget, async () => {
        try {
          await verified(await api.post('connect/gitea', { provider: state.provider, endpoint: state.endpoint, username: user.value.trim(), password: pass.value, otp: otp.value.trim() || undefined }));
        } catch (error) {
          if (error.code === 'provider_otp_required') otpField.hidden = false;
          reportError(error);
        } finally {
          pass.value = '';
        }
      }) }, t('wizard.password.submit'))));
  }

  function deviceMethod() {
    const area = h('div', { class: 'stack' });
    const begin = async (event) => busy(event.currentTarget, async () => {
      try {
        const flow = await api.post('connect/device/start', { provider: state.provider, endpoint: endpointForRequest() });
        mount(area,
          h('p', {}, t('wizard.device.open', { name: providerName(state.provider) })),
          h('div', { class: 'user-code', 'aria-label': t('wizard.device.code') }, flow.userCode),
          h('div', { class: 'row' }, h('a', { class: 'btn primary', href: flow.verificationUri, target: '_blank', rel: 'noopener noreferrer' }, iconExternal(), t('wizard.device.go', { name: providerName(state.provider) })),
            h('span', { class: 'spinner', role: 'status', 'aria-label': t('wizard.device.waiting') }), h('span', { class: 'muted' }, t('wizard.device.waiting'))));
        let interval = flow.interval * 1000;
        const tick = async () => {
          try {
            const result = await api.post('connect/device/poll', { flowId: flow.flowId });
            if (result.status === 'granted') return verified(result);
            if (result.status === 'expired' || result.status === 'denied') {
              mount(area, notice('warn', t(`wizard.device.${result.status}`)), h('div', {}, h('button', { class: 'btn', type: 'button', onclick: begin }, t('wizard.device.again'))));
              return undefined;
            }
            if (result.status === 'slow_down') interval += 5000;
          } catch (error) {
            reportError(error);
            return undefined;
          }
          pollTimer = setTimeout(tick, interval);
          return undefined;
        };
        pollTimer = setTimeout(tick, interval);
      } catch (error) {
        reportError(error);
      }
    });
    mount(area, h('p', { class: 'muted' }, t('wizard.device.explain', { name: providerName(state.provider) })), h('div', {}, h('button', { class: 'btn primary', type: 'button', onclick: begin }, t('wizard.device.start', { name: providerName(state.provider) }))));
    return area;
  }

  function verifiedCard() {
    const { account, repositoryCount, pushableCount, warnings } = state.verified;
    const name = h('input', { type: 'text', value: `${providerName(state.provider)} ${account.login}`, maxlength: '60' });
    return h('div', { class: 'stack' },
      notice('ok', h('div', {}, h('strong', {}, t('wizard.verified', { login: account.login })), h('div', {}, t('wizard.verified_counts', { total: repositoryCount, pushable: pushableCount })))),
      warnings.map((warning) => notice('warn', t('wizard.warning.missing_scope', { scope: warning.scope }))),
      pushableCount === 0 ? notice('warn', t('wizard.no_pushable')) : null,
      h('label', { class: 'field' }, t('wizard.name'), name, h('span', { class: 'hint' }, t('wizard.name_hint'))),
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', onclick: () => { state.verified = null; connectStep(); } }, t('common.back')),
        h('button', { class: 'btn primary', type: 'button', onclick: (event) => busy(event.currentTarget, async () => {
          try {
            const { connection } = await api.post('connections', { credentialId: state.verified.credentialId, name: name.value.trim(), mode: 'selected' });
            state.connection = connection;
            repositoriesStep();
          } catch (error) {
            reportError(error);
          }
        }) }, t('common.continue'))));
  }

  function connectStep() {
    state.step = 1;
    stop();
    if (state.verified) return frame(h('section', { class: 'card stack' }, verifiedCard()));
    const methodView = { device: deviceMethod, password: passwordMethod, token: tokenMethod }[state.method];
    return frame(h('section', { class: 'card stack' },
      h('h2', {}, t('wizard.connect_to', { name: providerName(state.provider) })),
      addressField(), methodTabs(), methodView(),
      h('div', {}, h('button', { class: 'btn ghost', type: 'button', onclick: chooseServer }, t('common.back')))));
  }

  // --- steps 3 and 4 --------------------------------------------------------------------------------------
  async function repositoriesStep() {
    state.step = 2;
    const panel = h('div', { class: 'stack' });
    const mode = h('select', { 'aria-label': t('connections.mode'), onchange: async (event) => {
      try {
        state.connection = await api.patch(`connections/${state.connection.id}`, { mode: event.target.value });
        await repositoriesTab(state.connection, panel);
      } catch (error) {
        reportError(error);
      }
    } }, ['selected', 'all'].map((key) => h('option', { value: key }, t(`connections.mode.${key}`))));
    frame(h('section', { class: 'card stack' }, h('h2', {}, t('wizard.repositories.title')), h('p', { class: 'muted' }, t('wizard.repositories.text')), h('label', { class: 'field' }, t('connections.mode'), mode), panel,
      h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: doneStep }, t('common.continue')))));
    await repositoriesTab(state.connection, panel);
  }

  function doneStep() {
    state.step = 3;
    const start = (dryRun) => (event) => busy(event.currentTarget, async () => {
      try {
        await api.post('runs', { connectionId: state.connection.id, ...(dryRun ? { dryRun: 'full' } : {}) });
        toast(t(dryRun ? 'overview.preview_started' : 'overview.run_started'));
        navigate('/runs');
      } catch (error) {
        reportError(error);
      }
    });
    frame(h('section', { class: 'card hero' }, h('h2', {}, t('wizard.done.title')), h('p', {}, t('wizard.done.text')),
      notice('info', t('wizard.done.onboarding')),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', type: 'button', onclick: start(true) }, t('overview.preview')),
        h('button', { class: 'btn', type: 'button', onclick: start(false) }, iconPlay(), t('overview.run_now')),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => navigate('/') }, t('wizard.done.later')))));
  }

  chooseServer();
  return stop;
}
