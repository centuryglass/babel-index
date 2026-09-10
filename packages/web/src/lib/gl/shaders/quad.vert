#version 300 es
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
