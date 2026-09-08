// Provider/media transport selection (V2 P4b-A).
//
// This module decides from the immutable ResolvedModelCall captured before the
// pool. It never re-reads Settings/catalogues and never searches another
// provider. The chosen provider either has a valid media transport or the call
// fails closed with CAPABILITY_UNSUPPORTED.

import {
  ProviderSelectionError,
  type ResolvedModelCall,
} from "../providers/selection.js";

export type MediaInputKind = "image" | "document";

export type MediaProviderRoute =
  | { readonly kind: "claude-host-read"; readonly resolved: ResolvedModelCall }
  | { readonly kind: "chatgpt-data-url"; readonly resolved: ResolvedModelCall };

function unsupported(resolved: ResolvedModelCall, detail: string): never {
  throw new ProviderSelectionError("CAPABILITY_UNSUPPORTED", detail, {
    providerId: resolved.providerId,
    key: resolved.key,
    model: resolved.model,
  });
}

/** Select exactly one transport from the already-resolved provider/model. */
export function routeMediaProvider(
  resolved: ResolvedModelCall,
  input: MediaInputKind,
): MediaProviderRoute {
  if (resolved.providerId === "claude-local") {
    if (
      resolved.provider.capabilities.hostTools &&
      resolved.modelSnapshot.supportsHostTools &&
      resolved.modelSnapshot.inputModalities.includes("text")
    ) {
      return { kind: "claude-host-read", resolved };
    }
    return unsupported(
      resolved,
      `model ${resolved.model} cannot perform the required Read-host-tool media call`,
    );
  }

  // The direct backend has no host filesystem. Only an explicit image
  // modality on the captured account-visible model admits the data-URL path.
  // Documents are not silently rasterized or handed to Claude.
  if (input === "image" && resolved.modelSnapshot.inputModalities.includes("image")) {
    return { kind: "chatgpt-data-url", resolved };
  }
  return unsupported(
    resolved,
    `model ${resolved.model} does not advertise ${input} input for media enrichment`,
  );
}
