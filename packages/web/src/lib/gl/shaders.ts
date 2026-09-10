/**
 * Spike: one shader pair for every quad `gl/context.ts` draws - a textured
 * tile blit and a flat-color fill (the blank-cell fallback, the generic-fade
 * overlay) share it via `u_useTexture` rather than switching programs, since
 * a program bind is exactly the kind of per-draw state change §5.2's "one
 * draw call per cell" first cut wants to avoid multiplying.
 *
 * Inline strings rather than external `.vert`/`.frag` files - see the plan's
 * "no `.glsl` esbuild loader" non-goal.
 */

export const VERTEX_SRC = `#version 300 es
in vec2 a_pos;
uniform vec2 u_resolution;
uniform vec4 u_dstRect;
out vec2 v_uv;
void main() {
  vec2 px = u_dstRect.xy + a_pos * u_dstRect.zw;
  vec2 clip = (px / u_resolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_uv = a_pos;
}
`;

export const FRAGMENT_SRC = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform vec4 u_srcRect;
uniform sampler2D u_texture;
uniform vec4 u_color;
uniform float u_useTexture;
uniform float u_alpha;
out vec4 outColor;
void main() {
  vec2 uv = mix(u_srcRect.xy, u_srcRect.zw, v_uv);
  vec4 base = mix(u_color, texture(u_texture, uv), u_useTexture);
  outColor = vec4(base.rgb, base.a * u_alpha);
}
`;
