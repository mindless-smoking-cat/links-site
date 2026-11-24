import { createSceneRenderer } from './draw.js';

function loadSettings(module, bytes) {
  const address = module._scene_buffer(bytes.length);
  if (!address) throw new Error('Invalid scene size.');
  module.HEAPU8.set(bytes, address);
}

async function artwork(name) {
  const image = new Image();
  image.src = new URL('./assets/' + name, import.meta.url).href;
  await image.decode();
  return image;
}

async function stockScene(canvas, bytes) {
  const [{default: createModule}, background, center] = await Promise.all([
    import('./scene.js'), artwork('background.webp'), artwork('center.webp')
  ]);
  const module = await createModule();
  loadSettings(module, bytes);
  if (!module._scene_load()) throw new Error('The bundled scene could not be opened.');
  return {module, draw: createSceneRenderer(canvas, module, background, center), circle: true};
}

async function desktopScene(canvas, bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 4;
  function take(size) {
    if (size > bytes.length - offset) throw new Error('Incomplete desktop scene bundle.');
    const part = bytes.subarray(offset, offset + size);
    offset += size;
    return part;
  }
  function number() {
    const start = offset;
    take(4);
    return view.getUint32(start, true);
  }
  const size = number(), count = number();
  const {default: createModule} = await import('./desktop.js');
  const module = await createModule({canvas});
  loadSettings(module, take(size));
  for (let i = 0; i < count; i++) module.FS.writeFile('art' + i, take(number()));
  if (offset !== bytes.length) throw new Error('Unexpected trailing scene data.');
  function open() {
    if (!module._desktop_open()) throw new Error(module.ccall('desktop_error', 'string', [], []));
  }
  open();
  let available = true;
  canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); available = false; });
  canvas.addEventListener('webglcontextrestored', () => {
    module._desktop_close();
    open();
    available = true;
  });
  const draw = {
    reset() { module._scene_reset(); },
    frame(seconds, dt, playing) {
      if (!available) return;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;
      const scale = Math.min(devicePixelRatio || 1, 2);
      const width = Math.round(w * scale), height = Math.round(h * scale);
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      module._desktop_frame(w, h, width / w, height / h, seconds, dt, playing);
    }
  };
  return {module, draw, circle: false};
}

export async function loadVisualizer(canvas) {
  const response = await fetch(new URL('./assets/site.scene', import.meta.url));
  if (!response.ok) throw new Error('Could not load the scene.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  const magic = String.fromCharCode(...bytes.subarray(0, 4));
  if (magic === 'CQS1') return stockScene(canvas, bytes);
  if (magic === 'CQP1') return desktopScene(canvas, bytes);
  throw new Error('Unrecognized scene format.');
}
