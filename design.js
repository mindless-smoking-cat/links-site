// Shared with SceneDesign::Change. The settings block stays opaque to JavaScript.
const changes = {
  live: 15, crop: 16, pickBackground: 32, pickCircle: 64, editCrop: 128,
  removeBackground: 256, removeCircle: 512, close: 1024, applyCrop: 2048, cancelCrop: 4096
};
const keys = ['', 'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'Escape', ' ',
  'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'a', 'c', 'v', 'x', 'y', 'z'];

function artworkCanvas(source, maximum = 4096) {
  if (source instanceof ImageData) {
    const original = document.createElement('canvas');
    original.width = source.width;
    original.height = source.height;
    original.getContext('2d').putImageData(source, 0, 0);
    source = original;
  }
  const width = source.naturalWidth ?? source.width, height = source.naturalHeight ?? source.height;
  const scale = Math.min(1, maximum / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function readArtwork(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return artworkCanvas(image);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function bindDesignMenu(scene, draw) {
  const byId = id => document.getElementById(id);
  const panel = byId('design-panel'), canvas = byId('design-canvas'), toggle = byId('design-toggle');
  const status = byId('design-status');
  const inputs = [byId('background-file'), byId('circle-file')];
  let menu, loadingMenu, initialized = false, available = false;
  let settingsAddress = 0, sceneAddress = 0, settingsSize = 0;
  let session = 0, animation = 0, previousFrame = 0;
  let pointer = null, pending = false, cropImage = null, replacement = null;

  function panelLimits({width, height}) {
    const viewport = document.documentElement;
    return {right: viewport.clientWidth - width, bottom: viewport.clientHeight - height};
  }
  function placePanel(x, y, limits) {
    const left = Math.max(0, Math.min(x, limits.right));
    const top = Math.max(0, Math.min(y, limits.bottom));
    panel.style.inset = `${top}px auto auto ${left}px`;
  }
  function keepPanelInView() {
    if (panel.hidden) return;
    const bounds = panel.getBoundingClientRect();
    const limits = panelLimits(bounds);
    if (pointer?.drag) pointer.drag.limits = limits;
    if (panel.style.left) placePanel(bounds.left, bounds.top, limits);
  }

  function setStatus(message = '', busy = false) {
    if (available) menu.ccall('menu_status', null, ['string', 'number'], [message, busy]);
  }
  function sync() {
    if (!available) return;
    sceneAddress = scene._design_settings();
    menu.HEAPU8.set(scene.HEAPU8.subarray(sceneAddress, sceneAddress + settingsSize), settingsAddress);
  }
  function transfer(flags, settings = menu.HEAPU8.subarray(settingsAddress, settingsAddress + settingsSize)) {
    scene.HEAPU8.set(settings, sceneAddress);
    scene._design_changes(flags);
  }
  function endCrop() {
    if (available) menu._menu_end_crop();
    cropImage = replacement = null;
  }
  function close() {
    session++;
    cancelAnimationFrame(animation);
    endCrop();
    if (pointer) {
      if (canvas.hasPointerCapture(pointer.id)) canvas.releasePointerCapture(pointer.id);
      pointer = null;
    }
    if (available) {
      menu._menu_button(false);
      menu._menu_focus(false);
    }
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    (byId('player-panel').inert ? byId('player-toggle') : toggle).focus({preventScroll: true});
  }
  function startCrop(source, isNew) {
    // The editor needs only a preview texture. The scene keeps the full artwork.
    const preview = artworkCanvas(source, 2048);
    const {width, height} = preview;
    const {data} = preview.getContext('2d').getImageData(0, 0, width, height);
    const address = menu._malloc(data.length);
    if (!address) throw new Error('The circle image is too large to preview.');
    try {
      menu.HEAPU8.set(data, address);
      if (!menu._menu_preview(width, height, address, !isNew)) throw new Error('Could not preview the circle image.');
    } finally {
      menu._free(address);
    }
    cropImage = source;
    replacement = isNew ? source : null;
  }
  async function updateArtwork(slot, image, cropSettings) {
    await draw.setArtwork(slot, image);
    if (cropSettings) transfer(changes.crop, cropSettings);
    sync();
  }
  async function perform(operation, message) {
    if (pending) return;
    const current = session;
    pending = true;
    setStatus(message, true);
    let error = '';
    try {
      await operation(current);
    } catch (failure) {
      if (current === session) error = failure.message || 'Could not change the artwork.';
    } finally {
      pending = false;
      if (!panel.hidden) setStatus(error);
    }
  }
  function handle(flags) {
    if (flags & changes.close) return close();
    if (flags & changes.live) transfer(flags & changes.live);
    if (flags & changes.pickBackground) inputs[0].click();
    if (flags & changes.pickCircle) inputs[1].click();
    if (flags & changes.editCrop) perform(() => startCrop(draw.circleArtwork(), false), 'Opening crop…');
    if (flags & changes.removeBackground) perform(() => updateArtwork(0, null), 'Removing background…');
    if (flags & changes.removeCircle) perform(() => updateArtwork(1, null), 'Removing circle image…');
    if (flags & changes.cancelCrop) {
      endCrop();
      sync();
      setStatus();
    }
    if (flags & changes.applyCrop) {
      if (replacement) {
        const settings = menu.HEAPU8.slice(settingsAddress, settingsAddress + settingsSize);
        const image = replacement;
        perform(async current => {
          await updateArtwork(1, image, settings);
          if (session === current) endCrop();
        }, 'Applying crop…');
      } else {
        transfer(changes.crop);
        endCrop();
        setStatus();
      }
    }
  }
  function render(now) {
    if (!available || panel.hidden) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    const dt = previousFrame ? (now - previousFrame) / 1000 : 1 / 60;
    previousFrame = now;
    const scale = Math.min(devicePixelRatio || 1, 2);
    const width = Math.round(w * scale), height = Math.round(h * scale);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const flags = menu._menu_frame(w, h, width / w, height / h, dt);
    canvas.style.cursor = pointer?.drag || menu._menu_pan_cursor?.() ? (pointer ? 'grabbing' : 'grab') : '';
    handle(flags);
  }
  function animate(now) {
    render(now);
    if (!panel.hidden) animation = requestAnimationFrame(animate);
  }
  function showStatus(message) {
    status.textContent = message;
    status.hidden = !message;
  }
  async function open() {
    const current = ++session;
    panel.hidden = false;
    keepPanelInView();
    toggle.setAttribute('aria-expanded', 'true');
    canvas.focus({preventScroll: true});
    try {
      if (!menu) {
        showStatus('Loading scene design…');
        const version = new URL(import.meta.url).search;
        loadingMenu ??= import(`./design-ui.js${version}`).then(({default: createMenu}) => createMenu({
          canvas,
          locateFile: file => new URL(`${file}${version}`, import.meta.url).href
        }));
        const instance = await loadingMenu;
        if (current !== session) return;
        menu = instance;
      }
      if (!initialized) {
        available = Boolean(menu._menu_open());
        if (!available) throw new Error('Scene design needs WebGL.');
        initialized = true;
        settingsAddress = menu._menu_settings();
        settingsSize = menu._menu_settings_size();
      }
      if (!available) return;
      showStatus('');
      sync();
      setStatus(pending ? 'Updating artwork…' : '', pending);
      menu._menu_focus(true);
      previousFrame = 0;
      animation = requestAnimationFrame(animate);
    } catch (error) {
      if (!menu) loadingMenu = null;
      if (current === session) showStatus(error.message || 'Could not open scene design.');
    }
  }

  toggle.disabled = false;
  window.addEventListener('resize', keepPanelInView);
  toggle.addEventListener('click', () => panel.hidden ? open() : close());
  byId('player-toggle').addEventListener('click', () => {
    if (!panel.hidden && byId('player-panel').inert) close();
  });
  document.addEventListener('keydown', event => {
    if (!panel.hidden && event.key === 'Escape' && (event.target !== canvas || !available)) close();
  });

  inputs.forEach((input, slot) => input.addEventListener('change', () => {
    const file = input.files[0];
    input.value = '';
    if (!file || panel.hidden || !available) return;
    perform(async current => {
      let image;
      try {
        image = await readArtwork(file);
      } catch {
        throw new Error('Could not read this image. Choose a different file.');
      }
      if (current !== session || !available) return;
      if (slot === 1) startCrop(image, true);
      else await updateArtwork(0, image);
    }, 'Opening image…');
  }));

  function moveMenuPointer(event) {
    const rect = canvas.getBoundingClientRect();
    menu._menu_mouse(event.clientX - rect.left, event.clientY - rect.top);
  }
  function movePanel(event, drag) {
    placePanel(event.clientX - drag.x, event.clientY - drag.y, drag.limits);
  }
  canvas.addEventListener('pointermove', event => {
    if (!available || !event.isPrimary || (pointer && event.pointerId !== pointer.id)) return;
    if (pointer?.drag) movePanel(event, pointer.drag);
    else moveMenuPointer(event);
  });
  canvas.addEventListener('pointerleave', () => {
    if (available && pointer === null) menu._menu_mouse(-10000, -10000);
  });
  canvas.addEventListener('pointerdown', event => {
    if (!available || pointer || !event.isPrimary || event.button !== 0) return;
    canvas.focus({preventScroll: true});
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    const drag = menu._menu_title_hit?.(x, y) ? {x, y, limits: panelLimits(rect)} : null;
    pointer = {id: event.pointerId, drag};
    canvas.setPointerCapture(pointer.id);
    if (drag) {
      canvas.style.cursor = 'grabbing';
      menu._menu_mouse(-10000, -10000);
      return;
    }
    menu._menu_mouse(x, y);
    menu._menu_button(true);
    render(performance.now());
  });
  function release(event) {
    if (event.pointerId !== pointer?.id) return;
    const {drag} = pointer;
    pointer = null;
    if (!available) return;
    if (event.type === 'pointerup') {
      if (drag) movePanel(event, drag);
      moveMenuPointer(event);
    } else {
      menu._menu_mouse(-10000, -10000);
    }
    if (drag) return;
    menu._menu_button(false);
    // Keep ImGui file buttons inside the browser's user activation.
    render(performance.now());
  }
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(type, release);
  canvas.addEventListener('wheel', event => {
    if (!available) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 3 : event.deltaMode === 2 ? 1 : 100;
    menu._menu_wheel(-event.deltaY / unit);
  }, {passive: false});
  for (const type of ['keydown', 'keyup']) canvas.addEventListener(type, event => {
    if (!available) return;
    const key = keys.indexOf(event.key.length === 1 ? event.key.toLowerCase() : event.key);
    const down = type === 'keydown';
    if (key > 0) event.preventDefault();
    menu._menu_key(key, down, event.shiftKey, event.ctrlKey, event.altKey, event.metaKey);
    if (down && event.key.length === 1 && !(event.ctrlKey || event.metaKey || event.altKey))
      menu.ccall('menu_text', null, ['string'], [event.key]);
    if (key === 6 || key === 8) render(performance.now());
  });
  canvas.addEventListener('blur', () => { if (available) menu._menu_focus(false); });
  canvas.addEventListener('focus', () => { if (available) menu._menu_focus(true); });
  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    available = false;
    showStatus('Restoring scene design…');
  });
  canvas.addEventListener('webglcontextrestored', () => {
    menu._menu_shutdown();
    available = Boolean(menu._menu_open());
    initialized = available;
    showStatus(available ? '' : 'Scene design could not restore its graphics.');
    if (!available || panel.hidden) return;
    sync();
    try {
      if (cropImage) startCrop(cropImage, Boolean(replacement));
    } catch (error) {
      endCrop();
      setStatus(error.message);
    }
  });
}
