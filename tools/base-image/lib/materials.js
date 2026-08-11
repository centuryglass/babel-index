/**
 * One material table, four output styles. Every asset is drawn from the same
 * scene, so the seam mask, the lineart and the schematic are pixel-aligned by
 * construction rather than by hand.
 *
 * `depth` is 0 (infinitely far) to 1 (nearest the viewer), used for the depth
 * map that ControlNet consumes.
 */
export const MATERIALS = {
  stone: { fill: '#3a332b', depth: 0.55, outline: true },
  stoneDark: { fill: '#241f19', depth: 0.45, outline: true },
  stoneLit: { fill: '#4e4638', depth: 0.6, outline: true },
  corner: { fill: '#141110', depth: 0.15, outline: true },
  void: { fill: '#080706', depth: 0.0, outline: true },
  farGlow: { fill: '#6b5b41', depth: 0.08, outline: true },
  caseBack: { fill: '#1d1913', depth: 0.42, outline: false },
  pier: { fill: '#5c5140', depth: 0.86, outline: true },
  board: { fill: '#6b5c46', depth: 0.8, outline: true },
  book: { fill: '#5a4a35', depth: 0.74, outline: true },
  lampGlobe: { fill: '#f4e3bb', depth: 0.9, outline: true },
  mirror: { fill: '#8f9aa0', depth: 0.34, outline: true },
  closet: { fill: '#100d0a', depth: 0.18, outline: true },
  rail: { fill: '#6f6250', depth: 0.96, outline: true },
  stair: { fill: '#4a4133', depth: 0.5, outline: true },
  stairPost: { fill: '#5a5040', depth: 0.55, outline: true },
  floor: { fill: '#332c24', depth: 0.7, outline: false },
  ceiling: { fill: '#2a251e', depth: 0.66, outline: false },
};

/** Spine tones, sampled deterministically per book. */
export const SPINE_TONES = [
  '#4a3c2b', '#5b4a33', '#6a563c', '#3f3426', '#54432f',
  '#7a6444', '#463a2a', '#625030', '#3a3025', '#6e5a3e',
];

const gray = (v) => {
  const n = Math.max(0, Math.min(255, Math.round(v * 255)));
  const h = n.toString(16).padStart(2, '0');
  return `#${h}${h}${h}`;
};

/**
 * Map a material to SVG paint attributes for a given output style.
 * @param {'schematic'|'lineart'|'depth'} style
 * @param {string} name key into MATERIALS
 * @param {{fill?: string, strokeWidth?: number}} [override]
 */
export function paint(style, name, override = {}) {
  const m = MATERIALS[name];
  if (!m) throw new Error(`unknown material: ${name}`);

  if (style === 'lineart') {
    return m.outline
      ? { fill: 'none', stroke: '#000000', 'stroke-width': override.strokeWidth ?? 1.2 }
      : { fill: 'none', stroke: 'none' };
  }
  if (style === 'depth') {
    return { fill: gray(m.depth), stroke: 'none' };
  }
  return { fill: override.fill ?? m.fill, stroke: 'none' };
}

export const background = (style) =>
  style === 'lineart' ? '#ffffff' : style === 'depth' ? gray(0.5) : MATERIALS.stone.fill;
