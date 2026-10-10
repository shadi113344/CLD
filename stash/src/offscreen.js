// Runs the on-device embedding model. Lives in an offscreen document because
// the ONNX runtime needs a DOM-ish context with WebAssembly, which MV3
// service workers can't provide. The model weights (~23 MB) are downloaded
// once from Hugging Face and cached by the browser; no bookmark text ever
// leaves this document.

import { pipeline, env } from '../vendor/transformers.min.js';

const MODEL = 'Xenova/all-MiniLM-L6-v2';

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('vendor/');
env.backends.onnx.wasm.numThreads = 1; // extension pages aren't cross-origin isolated

let extractor;
function getExtractor() {
  extractor ??= pipeline('feature-extraction', MODEL, { dtype: 'q8' });
  return extractor;
}

async function embed(texts) {
  const fx = await getExtractor();
  const out = [];
  // Small batches keep memory flat on large imports.
  for (let i = 0; i < texts.length; i += 8) {
    const t = await fx(texts.slice(i, i + 8), { pooling: 'mean', normalize: true });
    const dim = t.dims[1];
    for (let j = 0; j < t.dims[0]; j++) out.push(Array.from(t.data.subarray(j * dim, (j + 1) * dim)));
  }
  return out;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  if (msg.type === 'embed') {
    embed(msg.texts)
      .then((vectors) => sendResponse({ ok: true, vectors }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
});
