import { createSceneRenderer } from './draw.js';

async function rendererModule(name, options) {
  // Keep the renderer glue and its Wasm on the same release as this loader.
  const version = new URL(import.meta.url).search;
  const {default: createModule} = await import(`./${name}.js${version}`);
  return createModule({
    ...options,
    locateFile: file => new URL(file + version, import.meta.url).href
  });
}

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
  const [module, background, center] = await Promise.all([
    rendererModule('scene'), artwork('background.webp'), artwork('center.webp')
  ]);
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
  const module = await rendererModule('desktop', {canvas});
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
  const artworkPaths = ['', ''];
  let artworkVersion = 0;
  const draw = {
    circleArtwork() {
      if (!available) throw new Error('The scene is restoring its graphics. Try again.');
      const address = module._desktop_crop_preview();
      if (!address) throw new Error(module.ccall('desktop_error', 'string', [], []) || 'Could not open the circle image.');
      try {
        const width = module._desktop_crop_width(), height = module._desktop_crop_height();
        const pixels = new Uint8ClampedArray(module.HEAPU8.subarray(address, address + width * height * 4));
        return new ImageData(pixels, width, height);
      } finally {
        module._desktop_crop_release();
      }
    },
    async setArtwork(slot, image) {
      const path = image ? '/web-artwork-' + ++artworkVersion + '.png' : '';
      if (path) {
        const blob = await new Promise(resolve => image.toBlob(resolve, 'image/png'));
        if (!blob) throw new Error('Could not prepare the image.');
        module.FS.writeFile(path, new Uint8Array(await blob.arrayBuffer()));
      }
      if (!available || !module.ccall('desktop_artwork', 'number', ['number', 'string'], [slot, path])) {
        if (path) module.FS.unlink(path);
        throw new Error(available
          ? module.ccall('desktop_error', 'string', [], [])
          : 'The scene is restoring its graphics. Try again.');
      }
      if (artworkPaths[slot]) module.FS.unlink(artworkPaths[slot]);
      artworkPaths[slot] = path;
    },
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
  const response = await fetch(new URL('./assets/site.scene', import.meta.url), {cache: 'no-cache'});
  if (!response.ok) throw new Error('Could not load the scene.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  const magic = String.fromCharCode(...bytes.subarray(0, 4));
  if (magic === 'CQS1') return stockScene(canvas, bytes);
  if (magic === 'CQP1') return desktopScene(canvas, bytes);
  throw new Error('Unrecognized scene format.');
}
