// A tiny element builder. Text is always inserted as text, never as HTML, because repository names,
// descriptions and log lines come from other people.
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * h('button', { class: 'btn', onclick: fn, disabled: true }, 'Label', otherNode)
 * Props starting with "on" are event listeners, `class` accepts a string or a list, `dataset` and `aria`
 * take objects, everything else becomes an attribute (false and null are skipped).
 */
export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === false || value === null || value === undefined) continue;
    if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2), value);
    else if (key === 'class') element.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
    else if (key === 'dataset') Object.assign(element.dataset, value);
    else if (key === 'aria') for (const [name, text] of Object.entries(value)) element.setAttribute(`aria-${name}`, String(text));
    else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'selected') element[key] = value;
    else element.setAttribute(key, value === true ? '' : String(value));
  }
  append(element, children);
  return element;
}

export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

/** Replaces everything inside `parent`. */
export function mount(parent, ...children) {
  parent.replaceChildren();
  return append(parent, children);
}

export function svg(markup) {
  const wrapper = document.createElementNS(SVG_NS, 'svg');
  wrapper.setAttribute('viewBox', '0 0 24 24');
  wrapper.setAttribute('class', 'icon');
  wrapper.setAttribute('aria-hidden', 'true');
  // The markup is a constant of this app (see icons.mjs), never user data.
  wrapper.innerHTML = markup;
  return wrapper;
}

export const text = (value) => document.createTextNode(String(value));
