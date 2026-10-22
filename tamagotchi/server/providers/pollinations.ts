import { ProviderError, sniffImageMime, type GenerateInput, type ImageProvider } from "./types.ts";

// Free-tier friendly: Pollinations gives new accounts "Quest Pollen" credits.
// Nano Banana 2 is the default because it is strong at keeping a real person's
// likeness while restyling them. Override with POLLINATIONS_MODEL.
export const POLLINATIONS_DEFAULT_MODEL = "google/gemini-3.1-flash-image";
const ENDPOINT = "https://gen.pollinations.ai/v1/images/edits";

export function pollinationsProvider(apiKey: string, model = POLLINATIONS_DEFAULT_MODEL, fetchImpl: typeof fetch = fetch): ImageProvider {
  return {
    id: "pollinations",
    label: `Pollinations · ${model}`,
    model,
    billable: true,
    async generate({ photo, photoMime, prompt, signal }: GenerateInput) {
      const form = new FormData();
      const ext = photoMime.split("/")[1] ?? "jpg";
      form.append("image", new Blob([new Uint8Array(photo)], { type: photoMime }), `face.${ext}`);
      form.append("prompt", prompt);
      form.append("model", model);
      form.append("size", "1024x1024");
      form.append("response_format", "b64_json");

      const res = await fetchImpl(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal,
      });
      if (!res.ok) throw await pollinationsError(res);

      const json = (await res.json()) as { data?: { b64_json?: string; url?: string }[] };
      const item = json.data?.[0];
      let image: Buffer | null = null;
      if (item?.b64_json) image = Buffer.from(item.b64_json, "base64");
      else if (item?.url) {
        const img = await fetchImpl(item.url, { signal });
        if (img.ok) image = Buffer.from(await img.arrayBuffer());
      }
      const mime = image && sniffImageMime(image);
      if (!image || !mime) throw new ProviderError("The image service returned no image. Try again.");
      return { image, mime };
    },
  };
}

async function pollinationsError(res: Response): Promise<ProviderError> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: { message?: string } | string; message?: string };
    detail = (typeof body.error === "string" ? body.error : body.error?.message) ?? body.message ?? "";
  } catch {
    /* non-JSON error body */
  }
  switch (res.status) {
    case 401:
      return new ProviderError("Your POLLINATIONS_API_KEY was rejected. Create a secret key (sk_…) at enter.pollinations.ai.", 502);
    case 402:
      return new ProviderError("Your Pollinations balance is empty. Claim free Quest Pollen at enter.pollinations.ai, then try again.", 402);
    case 429:
      return new ProviderError("Pollinations is rate-limiting us. Wait a minute and try again.", 429);
    case 400:
      return new ProviderError(`The image service refused this photo${detail ? `: ${detail.slice(0, 200)}` : "."}`, 400);
    default:
      return new ProviderError(`The image service failed (HTTP ${res.status}). Try again in a moment.`, 502);
  }
}
