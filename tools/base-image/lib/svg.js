const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

/** Minimal SVG element builder. `children` may be a string or an array. */
export function el(name, attrs = {}, children = null) {
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== null && v !== false)
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join('');
  if (children === null || children === undefined) return `<${name}${a}/>`;
  const body = Array.isArray(children) ? children.filter(Boolean).join('') : children;
  return `<${name}${a}>${body}</${name}>`;
}

export const rect = (r, attrs = {}) =>
  el('rect', { x: r.x, y: r.y, width: r.w, height: r.h, ...attrs });

export const svg = ({ width, height, children, defs = '' }) =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    el(
      'svg',
      {
        xmlns: 'http://www.w3.org/2000/svg',
        width,
        height,
        viewBox: `0 0 ${width} ${height}`,
      },
      [defs ? el('defs', {}, defs) : '', ...[].concat(children)]
    ),
  ].join('\n');

/** A clip path plus the group it clips, in one call. */
export function clipped(id, clipRect, children, groupAttrs = {}) {
  return {
    def: el('clipPath', { id }, rect(clipRect)),
    use: el('g', { 'clip-path': `url(#${id})`, ...groupAttrs }, children),
  };
}
