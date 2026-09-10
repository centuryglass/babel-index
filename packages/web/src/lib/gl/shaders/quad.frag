#version 300 es
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
