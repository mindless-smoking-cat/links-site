import { AudioAnalysis, preparePlaybackBuffer } from './analysis.js';
import { loadVisualizer } from './visualizer.js';

const byId = id => document.getElementById(id);
const canvas = byId('scene');
const play = byId('play');
const circlePlay = byId('circle-play');
const playerToggle = byId('player-toggle');
const panel = byId('player-panel');
const choose = byId('choose');
const picker = byId('audio-file');
const seek = byId('seek');
const volume = byId('volume');
const track = byId('track');
const defaultTrack = 'Clear Morning — 小倉唯';

playerToggle.addEventListener('click', () => {
  panel.inert = !panel.inert;
  playerToggle.setAttribute('aria-expanded', String(!panel.inert));
});

async function readDefaultTrack() {
  const response = await fetch(new URL('./assets/clear-morning.m4a', import.meta.url));
  if (!response.ok) throw new Error('Could not load ' + defaultTrack);
  return response.arrayBuffer();
}

function clock(seconds) {
  const whole = Math.floor(seconds);
  return Math.floor(whole / 60) + ':' + String(whole % 60).padStart(2, '0');
}

async function initialize() {
  const {module, draw, circle} = await loadVisualizer(canvas);
  circlePlay.hidden = !circle;
  if (!circle) canvas.setAttribute('aria-label', 'Live audio visualizer');
  const analysis = new AudioAnalysis(module);
  let context, outputGain, buffer, source;
  let loadVersion = 0, transportVersion = 0;
  let offset = 0, startedAt = 0, previousFrame = 0;
  let releaseStart = null;
  let seekPointer = null;
  let previewSeconds = null;

  function setTrackLabel(label, isError = false) {
    track.textContent = track.title = label;
    track.classList.toggle('error', isError);
  }
  function audioContext() {
    if (!context) {
      context = new AudioContext({ sampleRate: 48000 });
      outputGain = context.createGain();
      outputGain.gain.value = Number(volume.value) / 100;
      outputGain.connect(context.destination);
    }
    return context;
  }
  volume.addEventListener('input', () => {
    const percent = volume.value + '%';
    byId('volume-percent').textContent = percent;
    volume.setAttribute('aria-valuetext', percent);
    if (outputGain) {
      const gain = Number(volume.value) / 100;
      if (source) outputGain.gain.setTargetAtTime(gain, context.currentTime, 0.01);
      else outputGain.gain.setValueAtTime(gain, context.currentTime);
    }
  });
  function position() {
    if (!source) return offset;
    return Math.min(buffer.duration, offset + Math.max(0, context.currentTime - startedAt));
  }
  function timeline(seconds) {
    seek.value = seconds;
    seek.style.setProperty('--pos', (buffer ? seconds / buffer.duration * 100 : 0) + '%');
    byId('elapsed').textContent = clock(seconds);
    seek.setAttribute('aria-valuetext', clock(seconds));
  }
  function controls() {
    const label = source ? 'Pause' : 'Play';
    circlePlay.disabled = play.disabled || Boolean(source);
    byId('play-label').textContent = label;
    play.classList.toggle('playing', Boolean(source));
    play.setAttribute('aria-label', buffer ? label : 'Play ' + defaultTrack);
    byId('duration').textContent = clock(buffer?.duration ?? 0);
    seek.disabled = !buffer;
    byId('timeline').hidden = !buffer;
    seek.max = buffer?.duration || 1;
    if (seekPointer === null) timeline(offset);
  }
  function render(now) {
    const dt = previousFrame ? (now - previousFrame) / 1000 : 1 / 30;
    let sceneSeconds = 0;
    if (source) {
      sceneSeconds = position();
      analysis.sample(sceneSeconds);
      if (seekPointer === null) timeline(sceneSeconds);
    } else if (releaseStart !== null) {
      // Run the preset's release envelopes against silence while the transport
      // stays paused. Two seconds covers the ribbon's decay and transient effects.
      const elapsed = Math.max(0, (now - releaseStart) / 1000);
      if (elapsed < 2) sceneSeconds = offset + elapsed;
      else releaseStart = null;
    }
    draw.frame(sceneSeconds, dt, Boolean(source));
    previousFrame = now;
    requestAnimationFrame(render);
  }
  function stopSource() {
    transportVersion++;
    if (source) {
      offset = position();
      source.onended = null;
      source.stop();
      source.disconnect();
      source = null;
    }
  }
  function startSource() {
    if (offset >= buffer.duration) {
      offset = 0;
      draw.reset();
    }
    source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(outputGain);
    startedAt = context.currentTime;
    source.start(startedAt, offset);
    releaseStart = null;
    source.onended = () => {
      source.disconnect();
      source = null;
      offset = buffer.duration;
      analysis.silence();
      draw.reset();
      controls();
    };
    controls();
  }
  async function loadTrack(file) {
    const name = file ? file.name : defaultTrack;
    const version = ++loadVersion;
    seekPointer = previewSeconds = null;
    stopSource();
    buffer = null;
    offset = 0;
    releaseStart = null;
    analysis.setBuffer(null);
    draw.reset();
    play.disabled = true;
    controls();
    setTrackLabel('Opening ' + name + '…');
    try {
      const ctx = audioContext();
      const bytes = await (file ? file.arrayBuffer() : readDefaultTrack());
      if (version !== loadVersion) return;
      const decoded = await preparePlaybackBuffer(await ctx.decodeAudioData(bytes));
      if (version !== loadVersion) return;
      analysis.setBuffer(decoded);
      buffer = decoded;
      setTrackLabel(name);
    } catch (error) {
      if (version !== loadVersion) return;
      console.error(error);
      setTrackLabel(file
        ? 'Could not read this file. Choose another or press Play for Clear Morning.'
        : 'Could not load Clear Morning. Press Play to retry or choose audio.', true);
    } finally {
      if (version === loadVersion) {
        play.disabled = false;
        controls();
      }
    }
  }
  choose.addEventListener('click', () => picker.click());
  picker.addEventListener('change', () => {
    const file = picker.files[0];
    if (!file) return;
    picker.value = '';
    loadTrack(file);
  });
  async function startPlayback() {
    const loading = buffer ? undefined : loadTrack();
    const version = ++transportVersion;
    try {
      await Promise.all([audioContext().resume(), loading]);
      if (transportVersion === version && buffer) startSource();
    } catch (error) {
      if (transportVersion !== version) return;
      console.error(error);
      setTrackLabel('Playback could not start.', true);
    }
  }
  circlePlay.addEventListener('click', startPlayback);
  play.addEventListener('click', () => {
    if (!source) return startPlayback();
    stopSource();
    analysis.silence();
    releaseStart = performance.now();
    controls();
  });
  function commitSeek(seconds) {
    if (!buffer) return;
    const resume = Boolean(source);
    stopSource();
    offset = seconds;
    releaseStart = null;
    analysis.silence();
    draw.reset();
    if (resume && offset < buffer.duration) startSource();
    else controls();
  }
  seek.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    seekPointer = event.pointerId;
  });
  seek.addEventListener('input', () => {
    if (seekPointer === null) return commitSeek(seek.valueAsNumber);
    previewSeconds = seek.valueAsNumber;
    timeline(previewSeconds);
  });
  window.addEventListener('pointerup', event => {
    if (event.pointerId !== seekPointer) return;
    const target = previewSeconds;
    seekPointer = previewSeconds = null;
    if (target !== null) commitSeek(target);
    else timeline(position());
  });
  function cancelPreview() {
    if (seekPointer === null) return;
    seekPointer = previewSeconds = null;
    timeline(position());
  }
  window.addEventListener('pointercancel', event => {
    if (event.pointerId === seekPointer) cancelPreview();
  });
  window.addEventListener('blur', cancelPreview);
  play.disabled = choose.disabled = volume.disabled = false;
  setTrackLabel(defaultTrack);
  controls();
  requestAnimationFrame(render);
}
initialize().catch(error => {
  console.error(error);
  const message = byId('scene-error');
  message.textContent = 'Visualizer unavailable. ' + (error.message || 'Reload to try again.');
  message.hidden = false;
});
