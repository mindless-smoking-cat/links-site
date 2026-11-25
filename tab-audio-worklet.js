const blockFrames = 256;

class TabAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(blockFrames * 2);
    this.frames = 0;
  }

  process([input]) {
    const [left, right = left] = input;
    if (!left) {
      this.frames = 0;
      return false;
    }
    let start = 0;
    while (start < left.length) {
      if (this.frames === 0) this.firstFrame = currentFrame + start;
      const count = Math.min(left.length - start, blockFrames - this.frames);
      const end = start + count;
      this.samples.set(left.subarray(start, end), this.frames);
      this.samples.set(right.subarray(start, end), blockFrames + this.frames);
      this.frames += count;
      if (this.frames === blockFrames) {
        this.port.postMessage({ firstFrame: this.firstFrame, samples: this.samples });
        this.frames = 0;
      }
      start = end;
    }
    return false;
  }
}

registerProcessor('tab-audio', TabAudioProcessor);
