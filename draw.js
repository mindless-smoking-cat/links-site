// C++ records the same ordered, clipped ImDrawList triangles as the desktop
// renderer. WebGL only uploads buffers/textures, blends and submits them.
const vertexSource = `
attribute vec2 position;
attribute vec2 uv;
attribute vec4 color;
uniform vec2 viewport;
varying vec2 texCoord;
varying vec4 tint;
void main() {
  vec2 ndc = position / viewport * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
  texCoord = uv;
  tint = color;
}`;

const fragmentSource = `
precision highp float;
uniform sampler2D artwork;
varying vec2 texCoord;
varying vec4 tint;
void main() { gl_FragColor = tint * texture2D(artwork, texCoord); }`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
  return shader;
}

function prepare(gl, module, images, mipmaps) {
  const program = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]]) {
    const shader = compile(gl, type, source);
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);
  gl.uniform1i(gl.getUniformLocation(program, 'artwork'), 0);
  gl.enable(gl.BLEND);
  gl.enable(gl.SCISSOR_TEST);
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  const attributes = ['position', 'uv', 'color'].map(name => gl.getAttribLocation(program, name));
  for (const attribute of attributes) gl.enableVertexAttribArray(attribute);

  const textures = [null, ...images].map(image => {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (image) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      // WebGL 2 supports the original desktop trilinear filtering on these
      // non-power-of-two textures. WebGL 1 uses bilinear filtering.
      if (mipmaps) {
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      }
    } else {
      const start = module._scene_atlas();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 64, 64, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        module.HEAPU8.subarray(start, start + 64 * 64 * 4));
    }
    return texture;
  });
  return { textures, attributes, viewport: gl.getUniformLocation(program, 'viewport') };
}

export function createSceneRenderer(canvas, module, background, center) {
  const options = { alpha: false, antialias: false, depth: false, stencil: false };
  const webgl2 = canvas.getContext('webgl2', options);
  const gl = webgl2 || canvas.getContext('webgl', options);
  if (!gl) throw new Error('WebGL is unavailable in this browser.');
  const images = [background, center];
  let gpu = prepare(gl, module, images, Boolean(webgl2));
  canvas.addEventListener('webglcontextlost', event => event.preventDefault());
  canvas.addEventListener('webglcontextrestored', () => { gpu = prepare(gl, module, images, Boolean(webgl2)); });
  module._scene_image_sizes(background.naturalWidth, background.naturalHeight, center.naturalWidth, center.naturalHeight);

  return {
    reset() { module._scene_reset(); },
    frame(seconds, deltaSeconds, playing = true) {
      if (gl.isContextLost()) return;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (w < 1 || h < 1) return;
      const scale = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.round(w * scale), height = Math.round(h * scale);
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      gl.viewport(0, 0, width, height);
      gl.uniform2f(gpu.viewport, w, h);
      const count = module._scene_frame(w, h, seconds, deltaSeconds, playing);
      const bytes = module.HEAPU8;
      const vertices = module._scene_vertices(), indices = module._scene_indices();
      gl.bufferData(gl.ARRAY_BUFFER, bytes.subarray(vertices, vertices + module._scene_vertex_count() * 20), gl.STREAM_DRAW);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, bytes.subarray(indices, indices + module._scene_index_count() * 2), gl.STREAM_DRAW);
      const batches = new DataView(bytes.buffer, module._scene_batches(), count * 32);
      const [position, uv, color] = gpu.attributes;
      for (let i = 0; i < count; i++) {
        const ptr = i * 32;
        const texture = batches.getUint32(ptr, true);
        const firstIndex = batches.getUint32(ptr + 4, true);
        const indexCount = batches.getUint32(ptr + 8, true);
        const vertexOffset = batches.getUint32(ptr + 12, true) * 20;
        const x = Math.floor(batches.getFloat32(ptr + 16, true) * width / w);
        const y = Math.floor(batches.getFloat32(ptr + 20, true) * height / h);
        const right = Math.ceil(batches.getFloat32(ptr + 24, true) * width / w);
        const bottom = Math.ceil(batches.getFloat32(ptr + 28, true) * height / h);
        gl.scissor(x, height - bottom, right - x, bottom - y);
        gl.bindTexture(gl.TEXTURE_2D, gpu.textures[texture]);
        gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 20, vertexOffset);
        gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 20, vertexOffset + 8);
        gl.vertexAttribPointer(color, 4, gl.UNSIGNED_BYTE, true, 20, vertexOffset + 16);
        gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_SHORT, firstIndex * 2);
      }
    }
  };
}
