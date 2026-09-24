import { ProviderError, sniffImageMime, type GenerateInput, type ImageProvider } from "./types.ts";

// Direct Google Gemini API (needs billing enabled on the key's project; new
// Google Cloud accounts get trial credit). Nano Banana 2 by default.
export const GEMINI_DEFAULT_MODEL = "gemini-3.1-flash-image-preview";

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
}
interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
}

export function geminiProvider(apiKey: string, model = GEMINI_DEFAULT_MODEL, fetchImpl: typeof fetch = fetch): ImageProvider {
  return {
    id: "gemini",
    label: `Google Gemini · ${model}`,
    model,
    billable: true,
    async generate({ photo, photoMime, prompt, signal }: GenerateInput) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ inline_data: { mime_type: photoMime, data: photo.toString("base64") } }, { text: prompt }],
            },
          ],
          generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "1:1" } },
        }),
        signal,
      });
      const json = (await res.json().catch(() => ({}))) as GeminiResponse;
      if (!res.ok) {
        if (res.status === 400 || res.status === 403) {
          throw new ProviderError(`Gemini rejected the request: ${json.error?.message?.slice(0, 200) ?? res.status}`, 502);
        }
        if (res.status === 429) throw new ProviderError("Gemini quota hit. Image models need billing enabled on your key's project.", 429);
        throw new ProviderError(`Gemini failed (HTTP ${res.status}). Try again in a moment.`, 502);
      }
      if (json.promptFeedback?.blockReason) {
        throw new ProviderError(`Gemini blocked this photo (${json.promptFeedback.blockReason}). Try a different photo.`, 400);
      }
      const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
      const image = part?.inlineData?.data ? Buffer.from(part.inlineData.data, "base64") : null;
      const mime = image && sniffImageMime(image);
      if (!image || !mime) {
        const reason = json.candidates?.[0]?.finishReason;
        throw new ProviderError(`Gemini returned no image${reason ? ` (${reason})` : ""}. Try again or use another photo.`);
      }
      return { image, mime };
    },
  };
}
