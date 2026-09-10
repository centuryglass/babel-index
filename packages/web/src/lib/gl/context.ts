/**
 * Spike: the WebGL counterpart of a 2D `CanvasRenderingContext2D` - one quad
 * shader (`shaders.ts`), a static unit-quad VBO, and two draw calls
 * (`drawFlatQuad`, `drawTexturedQuad`) that `glRenderer.ts`/
 * `glSlideRenderer.ts` build a whole frame out of, one draw call per cell for
 * this first cut (see the plan's "Draw strategy" - no instancing yet).
 *
 * Everything here works in DEVICE pixels, not CSS pixels - unlike the 2D
 * renderer's `ctx.setTransform(dpr, ...)` trick, a shader has no implicit
 * pixel-ratio scale, so `resize()` takes the CSS size and dpr and the caller
 * is responsible for multiplying every rect it passes to a draw call by the
 * same dpr `resize()` was last called with.
 */
import { VERTEX_SRC, FRAGMENT_SRC } from './shaders.ts';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GLContext {
  gl: WebGL2RenderingContext;
  /** (cssWidth, cssHeight, dpr) - resizes the backing store and the viewport. */
  resize(w: number, h: number, dpr: number): void;
  clear(r: number, g: number, b: number, a: number): void;
  /** A solid-color quad, in device pixels - the blank fallback and the generic-fade overlay. */
  drawFlatQuad(dst: Rect, color: [number, number, number, number]): void;
  /**
   * A textured quad, in device pixels. `src` is in the TEXTURE's own pixel
   * space (not normalized) - this function divides by `texW`/`texH` itself,
   * mirroring how `render.ts`'s 9-arg `drawImage` takes a source rect in the
   * same terms.
   */
  drawTexturedQuad(
    texture: WebGLTexture,
    src: Rect,
    texW: number,
    texH: number,
    dst: Rect,
    alpha?: number
  ): void;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('createShader failed');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`shader compile failed: ${log}`);
  }
  return shader;
}

function linkProgram(gl: WebGL2RenderingContext, vs: WebGLShader, fs: WebGLShader): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error('createProgram failed');
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`program link failed: ${log}`);
  }
  return program;
}

/** Null on a browser/device with no WebGL2 - callers fall back to nothing drawn, not to Canvas2D (see the plan's "WebGL2 only, no fallback" non-goal). */
export function createGLContext(canvas: HTMLCanvasElement): GLContext | null {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false });
  if (!gl) return null;

  const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
  const program = linkProgram(gl, vs, fs);
  gl.useProgram(program);

  const quadBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  // Two triangles covering the unit square, corner order matches a
  // TRIANGLE_STRIP: (0,0) (1,0) (0,1) (1,1).
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const aPos = gl.getAttribLocation(program, 'a_pos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const uResolution = gl.getUniformLocation(program, 'u_resolution');
  const uDstRect = gl.getUniformLocation(program, 'u_dstRect');
  const uSrcRect = gl.getUniformLocation(program, 'u_srcRect');
  const uColor = gl.getUniformLocation(program, 'u_color');
  const uUseTexture = gl.getUniformLocation(program, 'u_useTexture');
  const uAlpha = gl.getUniformLocation(program, 'u_alpha');
  const uTexture = gl.getUniformLocation(program, 'u_texture');

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  let resolutionW = canvas.width;
  let resolutionH = canvas.height;

  function resize(w: number, h: number, dpr: number) {
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    gl.viewport(0, 0, pw, ph);
    resolutionW = pw;
    resolutionH = ph;
  }

  function clear(r: number, g: number, b: number, a: number) {
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  function drawQuad(dst: Rect, srcUv: [number, number, number, number], useTexture: boolean, color: [number, number, number, number], alpha: number, texture: WebGLTexture | null) {
    gl.uniform2f(uResolution, resolutionW, resolutionH);
    gl.uniform4f(uDstRect, dst.x, dst.y, dst.w, dst.h);
    gl.uniform4f(uSrcRect, srcUv[0], srcUv[1], srcUv[2], srcUv[3]);
    gl.uniform4f(uColor, color[0], color[1], color[2], color[3]);
    gl.uniform1f(uUseTexture, useTexture ? 1 : 0);
    gl.uniform1f(uAlpha, alpha);
    if (useTexture && texture) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(uTexture, 0);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function drawFlatQuad(dst: Rect, color: [number, number, number, number]) {
    drawQuad(dst, [0, 0, 1, 1], false, color, color[3], null);
  }

  function drawTexturedQuad(
    texture: WebGLTexture,
    src: Rect,
    texW: number,
    texH: number,
    dst: Rect,
    alpha = 1
  ) {
    const uv: [number, number, number, number] = [
      src.x / texW,
      src.y / texH,
      (src.x + src.w) / texW,
      (src.y + src.h) / texH,
    ];
    drawQuad(dst, uv, true, [0, 0, 0, 1], alpha, texture);
  }

  return { gl, resize, clear, drawFlatQuad, drawTexturedQuad };
}
