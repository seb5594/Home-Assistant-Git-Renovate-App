// The footer shared by all of the author's web interfaces. It is self-contained on purpose: copy this file
// together with the .footer rules of app.css into another project, adapt `software`, and it works there too.
import { h } from './dom.mjs';

export const FOOTER = Object.freeze({
  author: { name: 'seb5594', fullName: 'Sebastian Schmidt', url: 'https://github.com/seb5594' },
  buttons: [
    { id: 'apps', url: 'https://github.com/seb5594/Home-Assistant-Apps' },
    { id: 'support', url: 'https://paypal.me/seb5594', emoji: '☕ 🍺' },
  ],
});

const external = { target: '_blank', rel: 'noopener noreferrer' };

/**
 * @param {object} options
 * @param {string} options.appVersion version of this app
 * @param {{name:string, version:string, url:string}} options.software the packaged software with the link to its release
 * @param {(key:string, params?:object) => string} options.t translation function with the keys footer.*
 */
export function renderFooter({ appVersion, software, t }) {
  const { author } = FOOTER;
  const authorLink = h('a', { href: author.url, ...external }, author.name);
  return h('footer', { class: 'footer' },
    h('div', { class: 'footer-inner' },
      h('div', { class: 'footer-versions' },
        appVersion, ' · ', h('a', { href: software.url, ...external, title: t('footer.release_title', { name: software.name, version: software.version }) }, `${software.name} ${software.version}`)),
      h('div', { class: 'footer-credit' },
        h('div', {},
          h('p', {}, t('footer.developed_by'), ' ', authorLink, ` (${author.fullName})`),
          h('p', {}, t('footer.made_with'), ' ', h('span', { class: 'heart', role: 'img', 'aria-label': t('footer.love') }, '♥'), ' ', t('footer.in_germany'))),
        h('div', { class: 'footer-buttons' },
          FOOTER.buttons.map((button) => h('a', { class: 'btn outline', href: button.url, ...external },
            t(`footer.${button.id}`), button.emoji ? ` ${button.emoji}` : null))))));
}
