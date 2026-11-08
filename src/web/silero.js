// @ts-check
// Silero VAD v5 (#75): the probability that a 32 ms frame (512 samples at
// 16 kHz) is speech. The ONNX runtime is passed in, so the same code runs
// in the page (onnxruntime-web, served by this server) and in Node tests.
//
// Like silero-vad's own wrapper, each frame is fed with the last 64 samples
// of the frame before, so speech starting at a frame boundary is seen whole.

export const SILERO_FRAME = 512;
const CONTEXT = 64;

/**
 * @typedef {{
 *   Tensor: new (type: string, data: Float32Array | BigInt64Array, dims?: readonly number[]) => unknown,
 *   InferenceSession: { create: (model: Uint8Array) => Promise<{ run: (feeds: Record<string, unknown>) => Promise<Record<string, any>> }> },
 * }} OrtLike
 */

/**
 * @param {OrtLike} ort @param {Uint8Array} model the silero_vad_v5.onnx bytes
 * @returns {Promise<{ probability: (frame: Float32Array) => Promise<number>, reset: () => void }>}
 */
export const makeSilero = async (ort, model) => {
  const session = await ort.InferenceSession.create(model);
  const sampleRate = new ort.Tensor("int64", BigInt64Array.from([16000n]), []);
  const zeros = () => new ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
  let state = zeros();
  let context = new Float32Array(CONTEXT);
  // One frame at a time: each depends on the state the one before left.
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();

  /** @param {Float32Array} frame */
  const run = async (frame) => {
    const input = new Float32Array(CONTEXT + frame.length);
    input.set(context, 0);
    input.set(frame, CONTEXT);
    context = frame.slice(-CONTEXT);
    const out = await session.run({ input: new ort.Tensor("float32", input, [1, input.length]), state, sr: sampleRate });
    state = out.stateN;
    const p = out.output?.data?.[0];
    return typeof p === "number" ? p : 0;
  };

  return {
    probability: (frame) => {
      if (frame.length !== SILERO_FRAME) return Promise.reject(new Error(`Silero needs ${SILERO_FRAME}-sample frames`));
      const result = queue.then(() => run(frame));
      queue = result.catch(() => undefined);
      return result;
    },
    reset: () => {
      state = zeros();
      context = new Float32Array(CONTEXT);
    },
  };
};
