/* global AudioWorkletProcessor, registerProcessor, sampleRate -- AudioWorklet globals */
// The mic's audio thread (#74): passes the raw samples to the page about
// every 20 ms. Nothing is kept here.
//
// The one class in Jarvis: the Web Audio API only accepts a subclass of
// AudioWorkletProcessor here (registerProcessor needs a constructor whose
// prototype has process()). It holds no Jarvis logic; that's in mic-lib.js.

// eslint-disable-next-line no-restricted-syntax -- registerProcessor requires an AudioWorkletProcessor subclass
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = [];
    this.count = 0;
    // ~20 ms at the context's sample rate (sampleRate is a worklet global).
    this.batch = Math.round(sampleRate / 50);
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      this.pending.push(channel.slice());
      this.count += channel.length;
      if (this.count >= this.batch) {
        const out = new Float32Array(this.count);
        let at = 0;
        for (const part of this.pending) {
          out.set(part, at);
          at += part.length;
        }
        this.port.postMessage(out, [out.buffer]);
        this.pending = [];
        this.count = 0;
      }
    }
    return true;
  }
}

registerProcessor("jarvis-capture", CaptureProcessor);
