// @ts-check
// Loads Silero VAD in the page (#75), from files this server hosts: the ONNX
// runtime's WebAssembly build and the Silero v5 model. No CDN. Runs on one
// thread (the page isn't cross-origin isolated), about 1 ms per 32 ms frame.

import { makeSilero } from "./silero.js";

/** @type {Promise<Awaited<ReturnType<typeof makeSilero>>> | undefined} */
let loading;

/** The VAD, loaded once. Rejects if the runtime or the model can't be loaded. */
export const loadVad = () => {
  loading ??= (async () => {
    const runtime = "/vendor/ort/ort.wasm.min.mjs"; // a variable, so no bundler or type checker resolves it
    const ort = await import(runtime);
    ort.env.wasm.wasmPaths = "/vendor/ort/";
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    const res = await fetch("/vendor/silero_vad_v5.onnx");
    if (!res.ok) throw new Error(`the voice-detection model didn't load (${res.status})`);
    return makeSilero(ort, new Uint8Array(await res.arrayBuffer()));
  })();
  loading.catch(() => {
    loading = undefined; // try again next time
  });
  return loading;
};
