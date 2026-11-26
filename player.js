import { AudioAnalysis, preparePlaybackBuffer } from './analysis.js';
import { loadVisualizer } from './visualizer.js?v=3';
import { bindDesignMenu } from './design.js?v=3';

const byId = id => document.getElementById(id);
const canvas = byId('scene');
const play = byId('play');
const loop = byId('loop');
const circlePlay = byId('circle-play');
const playerToggle = byId('player-toggle');
const panel = byId('player-panel');
const choose = byId('choose');
const picker = byId('audio-file');
const tabAudioButton = byId('tab-audio');
const tabAudioStatus = byId('tab-audio-status');
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
  bindDesignMenu(module, draw);
  circlePlay.hidden = !circle;
  if (!circle) canvas.setAttribute('aria-label', 'Live audio visualizer');
  const analysis = new AudioAnalysis(module);
  let context, outputGain, buffer, source;
  let tabAudio, tabRequestPending = false, tabWorkletLoaded = false;
  let looping = false;
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
  function position(now = context.currentTime) {
    if (!source) return offset;
    const seconds = offset + Math.max(0, now - startedAt);
    return source.loop ? seconds % buffer.duration : Math.min(buffer.duration, seconds);
  }
  function timeline(seconds) {
    seek.value = seconds;
    seek.style.setProperty('--pos', (buffer ? seconds / buffer.duration * 100 : 0) + '%');
    byId('elapsed').textContent = clock(seconds);
    seek.setAttribute('aria-valuetext', clock(seconds));
  }
  function controls() {
    const label = source ? 'Pause' : 'Play';
    const listening = Boolean(tabAudio);
    circlePlay.disabled = play.disabled || Boolean(source) || listening;
    tabAudioButton.disabled = play.disabled || tabRequestPending;
    choose.disabled = tabRequestPending;
    byId('tab-audio-label').textContent = listening ? 'Stop sharing' : 'Tab audio';
    tabAudioButton.title = listening ? 'Stop sharing tab audio' : 'Play and visualize audio from another browser tab';
    byId('media-bar').classList.toggle('tab-audio-active', listening);
    byId('transport').hidden = byId('playback-adjustments').hidden = listening;
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
    if (tabAudio) {
      sceneSeconds = analysis.sampleLive(context.currentTime - tabAudio.monitorDelay);
    } else if (source) {
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
    draw.frame(sceneSeconds, dt, Boolean(source || tabAudio));
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
  function stopTabAudio() {
    if (!tabAudio) return;
    const { audioTrack, input, receiver, delay, trackLabel, trackError } = tabAudio;
    tabAudio = null;
    delay.disconnect();
    audioTrack.removeEventListener('ended', stopTabAudio);
    audioTrack.stop();
    input.disconnect();
    receiver.onprocessorerror = null;
    receiver.port.close();
    analysis.setBuffer(buffer);
    draw.reset();
    setTrackLabel(trackLabel, trackError);
    controls();
  }

  async function startTabAudio() {
    tabRequestPending = true;
    tabAudioStatus.textContent = '';
    controls();
    let stream, input, receiver, delay, liveBuffer;
    try {
      const ctx = audioContext();
      const resumed = ctx.resume().then(() => true, () => false);
      const options = {
        video: { displaySurface: 'browser' },
        audio: {
          suppressLocalAudioPlayback: true,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          latency: { ideal: 0.01 }
        },
        selfBrowserSurface: 'exclude',
        monitorTypeSurfaces: 'exclude',
        windowAudio: 'exclude',
        systemAudio: 'exclude',
        surfaceSwitching: 'exclude'
      };
      if (globalThis.CaptureController?.prototype.setFocusBehavior) {
        options.controller = new CaptureController();
        options.controller.setFocusBehavior('no-focus-change');
      }
      stream = await navigator.mediaDevices.getDisplayMedia(options);
      const videoTrack = stream.getVideoTracks()[0];
      const surface = videoTrack?.getSettings().displaySurface;
      // The picker requires video. Release it immediately after checking the source.
      videoTrack?.stop();
      if (surface !== 'browser') {
        tabAudioStatus.textContent = 'Select a browser tab and enable Share tab audio.';
        return;
      }
      const audioTrack = stream.getAudioTracks()[0];
      if (!audioTrack) {
        tabAudioStatus.textContent = 'No audio was shared. Enable Share tab audio in your browser’s picker.';
        return;
      }
      if (audioTrack.getSettings().suppressLocalAudioPlayback !== true) {
        tabAudioStatus.textContent = 'The browser could not route tab audio for synchronized playback.';
        return;
      }
      if (!await resumed) throw new Error('Audio context did not resume.');
      if (!tabWorkletLoaded) {
        await ctx.audioWorklet.addModule(new URL('./tab-audio-worklet.js', import.meta.url));
        tabWorkletLoaded = true;
      }
      if (audioTrack.readyState !== 'live') throw new Error('Tab sharing ended.');
      input = ctx.createMediaStreamSource(new MediaStream([audioTrack]));
      receiver = new AudioWorkletNode(ctx, 'tab-audio', {
        numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit'
      });
      input.connect(receiver);
      liveBuffer = analysis.setLiveInput(ctx.sampleRate);
      receiver.port.onmessage = ({ data: { firstFrame, samples } }) => liveBuffer.append(firstFrame, samples);
      // Let the original analysis window fill before playing the captured
      // samples. A small margin covers worklet messages and display frames.
      const monitorDelay = (analysis.frames - analysis.anchor) / ctx.sampleRate + 0.025;
      delay = ctx.createDelay(monitorDelay);
      delay.delayTime.value = monitorDelay;
      input.connect(delay).connect(ctx.destination);
      receiver.onprocessorerror = () => {
        if (tabAudio?.receiver !== receiver) return;
        stopTabAudio();
        tabAudioStatus.textContent = 'Tab audio stopped. Select Tab audio to try again.';
      };
      audioTrack.addEventListener('ended', stopTabAudio, { once: true });
      stopSource();
      seekPointer = previewSeconds = releaseStart = null;
      draw.reset();
      tabAudio = {
        audioTrack, input, receiver, delay, monitorDelay,
        trackLabel: track.textContent, trackError: track.classList.contains('error')
      };
      setTrackLabel('Listening to tab');
    } catch (error) {
      if (error.name !== 'NotAllowedError') {
        console.error(error);
        tabAudioStatus.textContent = 'Tab audio could not start. Try sharing a browser tab again.';
      }
    } finally {
      if (!tabAudio) {
        delay?.disconnect();
        input?.disconnect();
        receiver?.port.close();
        stream?.getTracks().forEach(track => track.stop());
        if (liveBuffer) analysis.setBuffer(buffer);
      }
      tabRequestPending = false;
      controls();
    }
  }

  function startSource() {
    if (offset >= buffer.duration) {
      offset = 0;
      draw.reset();
    }
    source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = looping;
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
    stopTabAudio();
    tabAudioStatus.textContent = '';
    loadTrack(file);
  });
  tabAudioButton.addEventListener('click', () => {
    if (tabAudio) stopTabAudio();
    else startTabAudio();
  });
  window.addEventListener('pagehide', stopTabAudio);
  async function startPlayback() {
    if (tabAudio || tabRequestPending) return;
    const loading = buffer ? undefined : loadTrack();
    const version = ++transportVersion;
    try {
      // Treat songs as media on iOS and iPadOS so Silent Mode doesn't mute them.
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
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
  loop.addEventListener('click', () => {
    looping = !looping;
    loop.setAttribute('aria-pressed', String(looping));
    if (source) {
      // Rebase the playhead before switching out of the current loop cycle.
      const now = context.currentTime;
      offset = position(now);
      startedAt = now;
      source.loop = looping;
    }
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
  tabAudioButton.hidden = !navigator.mediaDevices?.getDisplayMedia || !window.AudioWorkletNode
    || !navigator.mediaDevices.getSupportedConstraints().suppressLocalAudioPlayback;
  play.disabled = loop.disabled = volume.disabled = false;
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
