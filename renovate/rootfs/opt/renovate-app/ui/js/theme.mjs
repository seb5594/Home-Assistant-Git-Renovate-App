// Light or dark, and the accent color. By default the interface follows what the user already sees:
// Home Assistant's own theme (the page runs in an iframe of the same origin, so its theme is readable),
// then the system setting. Settings can pin the theme and choose the accent: blue, Home Assistant's
// primary color, or a custom one.
const DEFAULT_ACCENT = '#2563eb';
const DARK_ACCENT = '#5b9dff';

function parentDocument() {
  try {
    return window.parent !== window ? window.parent.document : null;
  } catch {
    return null;
  }
}

function parseColor(value) {
  const text = String(value ?? '').trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((d) => d + d).join('') : hex[1];
    return [0, 2, 4].map((i) => Number.parseInt(digits.slice(i, i + 2), 16));
  }
  const rgb = /^rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/i.exec(text);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

const luminance = ([r, g, b]) => {
  const channel = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

/** Black or white, whichever reads better on the given color. */
export const readableOn = (color) => (luminance(parseColor(color) ?? [37, 99, 235]) > 0.4 ? '#101820' : '#ffffff');

function homeAssistantTheme() {
  const doc = parentDocument();
  if (!doc) return null;
  try {
    const hass = doc.querySelector('home-assistant')?.hass;
    const style = getComputedStyle(doc.documentElement);
    const background = parseColor(style.getPropertyValue('--primary-background-color'));
    return {
      dark: hass?.themes?.darkMode ?? (background ? luminance(background) < 0.25 : null),
      primary: style.getPropertyValue('--primary-color').trim() || null,
      language: hass?.language ?? hass?.locale?.language ?? null,
    };
  } catch {
    return null;
  }
}

export const homeAssistantLanguage = () => homeAssistantTheme()?.language ?? null;

/** @param {{theme:string, accent:string, accentColor:string|null}} preferences */
export function applyTheme({ theme, accent, accentColor }) {
  const ha = homeAssistantTheme();
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = theme === 'dark' || (theme === 'auto' && (ha?.dark ?? systemDark));
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';

  let color = dark ? DARK_ACCENT : DEFAULT_ACCENT;
  if (accent === 'custom' && accentColor) color = accentColor;
  else if (accent === 'home_assistant' && ha?.primary && parseColor(ha.primary)) color = ha.primary;
  root.style.setProperty('--accent', color);
  root.style.setProperty('--on-accent', readableOn(color));
}

/** Calls `onChange` when Home Assistant or the system switches theme, so the page follows live. */
export function watchTheme(onChange) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', onChange);
  const doc = parentDocument();
  if (!doc) return;
  try {
    new MutationObserver(onChange).observe(doc.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
  } catch {
    // The parent cannot be observed: the system setting still works.
  }
}
