// Run once on a freshly decoded file, before sharing it with playback and CQT.
export async function preparePlaybackBuffer(decoded) {
  if (decoded.numberOfChannels === 1) {
    // The desktop FFmpeg decoder maps mono to stereo with equal-power panning.
    // Web Audio duplicates mono at unity gain, so apply the decoder gain here.
    const mono = decoded.getChannelData(0);
    for (let i = 0; i < mono.length; ++i) mono[i] *= Math.SQRT1_2;
    return decoded;
  }
  if (decoded.numberOfChannels === 2) return decoded;
  const offline = new OfflineAudioContext(2, decoded.length, decoded.sampleRate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  return offline.startRendering();
}

// Keep only the recent stereo samples needed by live analysis.
class LiveAudioBuffer {
  constructor(sampleRate, capacity) {
    this.sampleRate = sampleRate;
    this.numberOfChannels = 2;
    this.firstFrame = null;
    this.availableFrom = 0;
    this.length = 0;
    this.channels = [new Float32Array(capacity), new Float32Array(capacity)];
  }

  append(firstFrame, samples) {
    this.firstFrame ??= firstFrame;
    const start = firstFrame - this.firstFrame;
    const frames = samples.length / 2;
    const [left, right] = this.channels;
    const capacity = left.length;
    const first = Math.max(0, frames - capacity);
    let index = (start + first) % capacity;
    for (let i = first; i < frames; ++i) {
      left[index] = samples[i];
      right[index] = samples[frames + i];
      if (++index === capacity) index = 0;
    }
    if (start > this.length) this.availableFrom = start;
    this.length = start + frames;
    this.availableFrom = Math.max(this.availableFrom, this.length - capacity);
  }

  copyFromChannel(destination, channel, start) {
    const samples = this.channels[channel];
    const index = start % samples.length;
    const count = Math.min(destination.length, this.length - start);
    const first = Math.min(count, samples.length - index);
    destination.set(samples.subarray(index, index + first));
    if (first < count) destination.set(samples.subarray(0, count - first), first);
  }
}

// CQT and its kernels live in Wasm. Supply an analysis window from either input.
export class AudioAnalysis {
  constructor(module) {
    this.module = module;
    this.setBuffer(null);
  }

  setBuffer(buffer) {
    this.buffer = buffer;
    if (buffer) this.prepare(buffer.sampleRate, buffer.numberOfChannels);
    else this.silence();
  }

  setLiveInput(sampleRate) {
    this.prepare(sampleRate, 2);
    this.livePlayhead = 0;
    // Retain enough history for the playback delay and the audio output buffer.
    this.buffer = new LiveAudioBuffer(sampleRate, this.frames + Math.ceil(sampleRate / 2));
    return this.buffer;
  }

  prepare(sampleRate, channels) {
    this.hop = Math.max(1, Math.floor(sampleRate / 30));
    this.lastTick = -1;
    this.frames = this.module._analysis_prepare(sampleRate);
    if (!this.frames) throw new Error("Unsupported audio sample rate.");
    this.anchor = this.module._analysis_anchor();
    this.pointer = this.module._analysis_pcm();
    this.leftWindow = new Float32Array(this.frames);
    this.rightWindow = channels > 1 ? new Float32Array(this.frames) : this.leftWindow;
  }

  silence() {
    this.lastTick = -1;
    this.module._analysis_silence();
  }

  sampleLive(contextTime) {
    const { firstFrame, length, sampleRate } = this.buffer;
    if (firstFrame === null) return 0;
    const frame = Math.floor(contextTime * sampleRate) - firstFrame;
    this.livePlayhead = Math.max(this.livePlayhead, Math.min(frame, length - (this.frames - this.anchor)));
    const seconds = this.livePlayhead / sampleRate;
    this.sample(seconds);
    return seconds;
  }

  sample(seconds) {
    if (!this.buffer || !Number.isFinite(seconds)) return;
    const { buffer, module, frames, anchor } = this;
    // Both the player and the offline renderer measure 30 CQT frames/second.
    const playhead = Math.min(buffer.length, Math.max(0, Math.round(seconds * buffer.sampleRate)));
    const tick = Math.floor(playhead / this.hop);
    if (tick === this.lastTick) return;
    this.lastTick = tick;
    const position = tick * this.hop;
    const start = position - anchor;
    const first = Math.min(frames, Math.max(0, (buffer.availableFrom ?? 0) - start));
    const end = Math.max(first, Math.min(frames, buffer.length - start));
    // Refresh the heap view because the renderer can grow Wasm memory.
    const offset = this.pointer / Float32Array.BYTES_PER_ELEMENT;
    const pcm = module.HEAPF32.subarray(offset, offset + frames * 2);
    pcm.fill(0, 0, first * 2);
    pcm.fill(0, end * 2);
    // Getting a full channel during playback can copy the entire track on the
    // render thread. Copy only the samples needed for this analysis window.
    if (end > first) {
      const sourceStart = start + first;
      const { leftWindow, rightWindow } = this;
      buffer.copyFromChannel(leftWindow, 0, sourceStart);
      if (buffer.numberOfChannels > 1) buffer.copyFromChannel(rightWindow, 1, sourceStart);
      for (let i = first; i < end; ++i) {
        pcm[i * 2] = leftWindow[i - first];
        pcm[i * 2 + 1] = rightWindow[i - first];
      }
    }
    module._analysis_update(anchor);
    module._desktop_sample?.(position);
  }
}
