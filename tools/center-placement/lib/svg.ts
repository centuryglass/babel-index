export type AttrValue = string | number | boolean | undefined | null;
export type Attrs = Record<string, AttrValue>;

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Minimal SVG element builder. `children` may be a string or an array. */
export function el(name: string, attrs: Attrs = {}, children: string | (string | false | null | undefined)[] | null = null): string {
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== null && v !== false)
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join('');
  if (children === null || children === undefined) return `<${name}${a}/>`;
  const body = Array.isArray(children) ? children.filter(Boolean).join('') : children;
  return `<${name}${a}>${body}</${name}>`;
}

export const rect = (r: Rect, attrs: Attrs = {}) =>
  el('rect', { x: r.x, y: r.y, width: r.w, height: r.h, ...attrs });

export interface SvgOptions {
  width: number;
  height: number;
  children: string | (string | false | null | undefined)[];
  defs?: string;
}

export const svg = ({ width, height, children, defs = '' }: SvgOptions) =>
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
      [defs ? el('defs', {}, defs) : '', ...([] as (string | false | null | undefined)[]).concat(children)]
    ),
  ].join('\n');

/** A clip path plus the group it clips, in one call. */
export function clipped(
  id: string,
  clipRect: Rect,
  children: string | (string | false | null | undefined)[],
  groupAttrs: Attrs = {}
) {
  return {
    def: el('clipPath', { id }, rect(clipRect)),
    use: el('g', { 'clip-path': `url(#${id})`, ...groupAttrs }, children),
  };
}
