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

// CQT and its kernels live in Wasm. Keep full-length decoded audio in Web Audio.
export class AudioAnalysis {
  constructor(module) {
    this.module = module;
    this.setBuffer(null);
  }

  setBuffer(buffer) {
    this.buffer = buffer;
    if (!buffer) {
      this.silence();
      return;
    }
    this.lastPosition = -1;
    this.frames = this.module._analysis_prepare(buffer.sampleRate);
    if (!this.frames) throw new Error("Unsupported audio sample rate.");
    this.anchor = this.module._analysis_anchor();
    this.pointer = this.module._analysis_pcm();
    this.leftWindow = new Float32Array(this.frames);
    this.rightWindow = buffer.numberOfChannels > 1 ? new Float32Array(this.frames) : this.leftWindow;
  }

  silence() {
    this.lastPosition = -1;
    this.module._analysis_silence();
  }

  sample(seconds) {
    if (!this.buffer || !Number.isFinite(seconds)) return;
    const { buffer, module, frames, anchor } = this;
    // Both the player and the offline renderer measure 30 CQT frames/second.
    const hop = Math.max(1, Math.floor(buffer.sampleRate / 30));
    const playhead = Math.min(buffer.length, Math.max(0, Math.round(seconds * buffer.sampleRate)));
    const position = Math.floor(playhead / hop) * hop;
    if (position === this.lastPosition) return;
    this.lastPosition = position;
    const start = position - anchor;
    const first = Math.max(0, -start);
    const end = Math.min(frames, buffer.length - start);
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
