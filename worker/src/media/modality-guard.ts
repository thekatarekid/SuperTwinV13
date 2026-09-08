import { ProviderSelectionError, type ResolvedModelCall } from "../providers/selection.js";
import { MAX_IMAGE_BATCH_SIZE } from "./batch.js";

export type MediaBatchKind = "image" | "document";

/** Fail-closed pre-encoding guard over the immutable resolved model snapshot. */
export function assertMediaModalityContract(
  resolved: ResolvedModelCall,
  kinds: readonly MediaBatchKind[],
): void {
  const unsupported = (message: string): never => {
    throw new ProviderSelectionError("CAPABILITY_UNSUPPORTED", message, {
      providerId: resolved.providerId, key: resolved.key, model: resolved.model,
    });
  };
  if (kinds.length === 0) unsupported("media input is empty");
  if (kinds.length > MAX_IMAGE_BATCH_SIZE) unsupported(`media input exceeds ${MAX_IMAGE_BATCH_SIZE} items`);
  if (kinds.includes("document") && kinds.length !== 1) unsupported("documents cannot be mixed or batched");

  if (resolved.providerId === "chatgpt-oauth") {
    if (kinds[0] === "document") unsupported("ChatGPT document transport is not supported");
    if (!resolved.modelSnapshot.inputModalities.includes("text") ||
        !resolved.modelSnapshot.inputModalities.includes("image")) {
      unsupported("ChatGPT media requires advertised text and image input");
    }
    return;
  }
  if (!resolved.provider.capabilities.hostTools || !resolved.modelSnapshot.supportsHostTools ||
      !resolved.modelSnapshot.inputModalities.includes("text")) {
    unsupported("Claude media requires the text and host Read capabilities");
  }
}
