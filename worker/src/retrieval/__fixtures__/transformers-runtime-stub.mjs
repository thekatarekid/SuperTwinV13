// A stand-in for the optional embedding runtime (@huggingface/transformers),
// with the two exports embedder.ts uses and nothing else. It exists because the
// real package is deliberately NOT a dependency (see embedder.ts), so the only
// way to check that our side of that seam is correct — the task name, the
// dtype, the pooling options, e5's query/passage prefixes, the [n, dim] reshape
// — is to drive something with its shape.
//
// It records every call on globalThis so the test can read them back, and
// returns a tensor whose first float per row is the input length, which makes
// "did the prefix get added" observable in the output as well as in the calls.

globalThis.__transformersStub = { env: {}, calls: [] };

export const env = globalThis.__transformersStub.env;

export async function pipeline(task, model, options) {
  globalThis.__transformersStub.calls.push({ task, model, options });
  return async function extract(input, opts) {
    globalThis.__transformersStub.calls.push({ input: [...input], opts });
    const dim = 384;
    const data = new Float32Array(input.length * dim);
    input.forEach((text, i) => {
      data[i * dim] = text.length;
    });
    return { data, dims: [input.length, dim] };
  };
}
