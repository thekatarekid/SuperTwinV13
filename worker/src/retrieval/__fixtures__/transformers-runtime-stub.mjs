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

// The reranker's half of the seam (reranker.ts, V6 S2.4): a tokenizer that
// records the (query, passage) pairs it was handed, and a sequence-classification
// head whose logit for each pair is the passage length minus the query length,
// so "did the pairs arrive, in order, and did sigmoid run" is observable.
export const AutoTokenizer = {
  async from_pretrained(model) {
    globalThis.__transformersStub.calls.push({ tokenizer: model });
    return function tokenize(text, options) {
      globalThis.__transformersStub.calls.push({ tokenize: [...text], options: { ...options, text_pair: [...options.text_pair] } });
      return { text: [...text], text_pair: [...options.text_pair] };
    };
  },
};

export const AutoModelForSequenceClassification = {
  async from_pretrained(model, options) {
    globalThis.__transformersStub.calls.push({ classifier: model, options });
    return async function classify(inputs) {
      const n = inputs.text.length;
      const data = new Float32Array(n);
      for (let i = 0; i < n; i++) data[i] = (inputs.text_pair[i].length - inputs.text[i].length) / 10;
      return { logits: { data, dims: [n, 1] } };
    };
  },
};
