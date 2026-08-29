// ===========================================================================
// Settings › the two model registries (defects 6, 5b and 7).
//
// All three defects were the same defect wearing different clothes: a list of
// models you could look at but not act on.
//
//   Intelligence › model per step   three bare family names — no versions, no
//                                   prices, no reasoning control, and no way
//                                   to reach the dozen models the local CLI
//                                   can actually run.
//   Intelligence › embedding model  four lines of inert text. It said
//                                   "EmbeddingGemma 300M recommended" and gave
//                                   you nothing to click.
//   Enrichment › whisper model      one dropdown over seven names, letting you
//                                   select a 3 GB model that was not on the
//                                   machine, with no way to see what was or to
//                                   reclaim the space.
//
// So what is pinned here is what a row can now DO: download, cancel, delete,
// switch to — with progress while it runs and the server's own words when it
// fails.
// ===========================================================================

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Settings } from "./screens/Settings";
import { stubWorker, type WorkerStub } from "./test-utils";

afterEach(() => {
  vi.unstubAllGlobals();
});

const GEMMA = "onnx-community/embeddinggemma-300m-ONNX";
const E5_SMALL = "Xenova/multilingual-e5-small";
const E5_BASE = "Xenova/multilingual-e5-base";

/** The shape the worker serves now: versioned ids, prices, reasoning levels. */
const MODELS = [
  {
    id: "claude-haiku-4-5-20251001",
    label: "Haiku 4.5",
    family: "haiku",
    alias: false,
    resolves_to: null,
    input_per_mtok: 1,
    output_per_mtok: 5,
    thinking_levels: ["off", "low", "medium", "high"],
    default_thinking: "off",
    effort: false,
    context_window: 200_000,
  },
  {
    id: "claude-opus-5",
    label: "Opus 5",
    family: "opus",
    alias: false,
    resolves_to: null,
    input_per_mtok: 5,
    output_per_mtok: 25,
    thinking_levels: ["off", "low", "medium", "high", "xhigh", "max"],
    default_thinking: "high",
    effort: true,
    context_window: 1_000_000,
  },
  {
    // The case the second dropdown has to be honest about.
    id: "claude-3-5-haiku-20241022",
    label: "Haiku 3.5",
    family: "haiku",
    alias: false,
    resolves_to: null,
    input_per_mtok: 0.8,
    output_per_mtok: 4,
    thinking_levels: [],
    default_thinking: null,
    effort: false,
    context_window: 200_000,
  },
];

function intelligence(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    default_model: "haiku",
    default_thinking: "off",
    options: ["haiku", "sonnet", "opus"],
    eval_gated: true,
    discovery: {
      mode: "discovered",
      source: "/Users/x/.local/bin/claude",
      error: null,
      discovered_at: "2026-08-29T10:00:00Z",
    },
    models: MODELS,
    steps: [
      {
        key: "orient.v6",
        label: "Orient",
        group: "Understanding",
        recommended: "sonnet",
        selected: "claude-haiku-4-5-20251001",
        thinking: "off",
        thinking_levels: ["off", "low", "medium", "high"],
        enabled: true,
        cost_7d_usd: 0.42,
        calls_7d: 12,
      },
      {
        key: "critic.v4",
        label: "Critic",
        group: "Understanding",
        recommended: "haiku",
        selected: "claude-3-5-haiku-20241022",
        thinking: "off",
        thinking_levels: [],
        enabled: true,
        cost_7d_usd: 0,
        calls_7d: 0,
      },
    ],
    ...over,
  };
}

function embeddingRegistry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    active: E5_SMALL,
    default: GEMMA,
    models: [
      {
        id: E5_SMALL,
        label: "Multilingual E5 Small",
        dim: 384,
        bytes: 135_000_000,
        bundled: true,
        recommended: false,
        active: true,
        present: true,
        indexed: 1200,
        files: [{ path: "onnx/model.onnx", bytes: 135_000_000, present: true, bytesOnDisk: 135_000_000 }],
        download: null,
      },
      {
        id: GEMMA,
        label: "EmbeddingGemma 300M",
        dim: 768,
        bytes: 330_000_000,
        bundled: false,
        recommended: true,
        active: false,
        present: false,
        indexed: 0,
        files: [],
        download: null,
      },
      {
        id: E5_BASE,
        label: "Multilingual E5 Base",
        dim: 768,
        bytes: 296_000_000,
        bundled: false,
        recommended: false,
        active: false,
        present: true,
        indexed: 0,
        files: [{ path: "onnx/model.onnx", bytes: 296_000_000, present: true, bytesOnDisk: 296_000_000 }],
        download: null,
      },
    ],
    swap: null,
    ...over,
  };
}

function mediaTools(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    modelsDir: "/Users/x/SuperTwinV13/models",
    models: [
      {
        id: "tiny",
        label: "Tiny",
        bytes: 77_691_713,
        bundled: false,
        present: false,
        bytesOnDisk: null,
        selected: false,
        download: null,
      },
      {
        id: "large-v3-turbo-q5_0",
        label: "Large v3 turbo (q5_0)",
        bytes: 574_041_195,
        bundled: true,
        present: true,
        bytesOnDisk: 574_041_195,
        selected: true,
        download: null,
      },
      {
        id: "large-v3-turbo",
        label: "Large v3 turbo",
        bytes: 1_623_251_309,
        bundled: false,
        present: true,
        bytesOnDisk: 1_623_251_309,
        selected: false,
        download: null,
      },
    ],
    ...over,
  };
}

const MEDIA_SETTINGS = {
  describe_enabled: true,
  backfill_enabled: true,
  images_enabled: true,
  video_enabled: true,
  business_enabled: false,
  link_scrape_enabled: true,
  video_frames_enabled: false,
  video_audio_enabled: true,
  voice_notes_enabled: true,
  rate_per_min: 30,
  concurrency: 2,
  video_frame_interval_sec: 5,
  video_frame_max: 8,
  video_max_height: 768,
  whisper_model: "large-v3-turbo-q5_0",
};

function stubModels(): WorkerStub {
  const stub = stubWorker();
  stub.routes.set("/api/settings/intelligence", intelligence());
  stub.routes.set("/api/retrieval/semantic/models", embeddingRegistry());
  stub.routes.set("/api/settings/media", MEDIA_SETTINGS);
  stub.routes.set("/api/media/tools", mediaTools());
  for (const p of [
    "/api/retrieval/semantic/models/download",
    "/api/retrieval/semantic/models/cancel",
    "/api/retrieval/semantic/models/delete",
    "/api/retrieval/semantic/models/activate",
  ]) {
    stub.routes.set(p, embeddingRegistry());
  }
  for (const p of [
    "/api/media/models/download",
    "/api/media/models/cancel",
    "/api/media/models/delete",
  ]) {
    stub.routes.set(p, mediaTools());
  }
  return stub;
}

async function openIntelligence(): Promise<void> {
  render(<Settings />);
  fireEvent.click(screen.getByRole("button", { name: "Intelligence" }));
  await screen.findByLabelText("Orient model");
}

async function openEnrichment(): Promise<void> {
  render(<Settings />);
  fireEvent.click(screen.getByRole("button", { name: "Enrichment" }));
  await screen.findByRole("heading", { name: /Voice/ });
}

// ---------------------------------------------------------------------------
// Defect 6 — the per-step model picker
// ---------------------------------------------------------------------------

describe("Settings › Intelligence — model per step", () => {
  it("offers versioned models with per-million prices, not three family names", async () => {
    stubModels();
    await openIntelligence();
    const picker = screen.getByLabelText("Orient model") as HTMLSelectElement;
    const options = [...picker.options].map((o) => o.textContent);
    expect(options).toEqual([
      "Haiku 4.5 — $1/M in · $5/M out",
      "Opus 5 — $5/M in · $25/M out",
      "Haiku 3.5 — $0.8/M in · $4/M out",
    ]);
    // The value is the id the CLI is actually given.
    expect(picker.value).toBe("claude-haiku-4-5-20251001");
    expect([...picker.options].map((o) => o.value)).toContain("claude-opus-5");
  });

  it("says whether the list was read from the CLI or is the curated fallback", async () => {
    const stub = stubModels();
    await openIntelligence();
    expect(screen.getByText(/read from the local Claude CLI/)).toBeTruthy();

    vi.unstubAllGlobals();
    const s2 = stubModels();
    s2.routes.set(
      "/api/settings/intelligence",
      intelligence({
        discovery: {
          mode: "fallback",
          source: "curated registry",
          error: "no baked model catalog found",
          discovered_at: "2026-08-29T10:00:00Z",
        },
      }),
    );
    render(<Settings />);
    fireEvent.click(screen.getAllByRole("button", { name: "Intelligence" })[1]!);
    await waitFor(() =>
      expect(screen.getByText(/curated fallback list/)).toBeTruthy(),
    );
    expect(screen.getByText(/no baked model catalog found/)).toBeTruthy();
    expect(stub.calls.length).toBeGreaterThan(0);
  });

  it("keeps the recommendation, the observed cost and the on/off toggle", async () => {
    stubModels();
    await openIntelligence();
    expect(screen.getAllByText("rec: sonnet")).toHaveLength(1);
    expect(screen.getByText("$0.42 / 7d")).toBeTruthy();
    expect((screen.getByLabelText("Orient enabled") as HTMLInputElement).checked).toBe(true);
  });

  it("has a SECOND dropdown for reasoning, built from the selected model's levels", async () => {
    const stub = stubModels();
    await openIntelligence();
    const thinking = screen.getByLabelText("Orient thinking") as HTMLSelectElement;
    expect(thinking.disabled).toBe(false);
    expect([...thinking.options].map((o) => o.value)).toEqual(["off", "low", "medium", "high"]);
    expect(thinking.value).toBe("off");

    fireEvent.change(thinking, { target: { value: "high" } });
    await waitFor(() => {
      const posts = stub.calls.filter(
        (c) => c.path === "/api/settings/intelligence" && c.method === "POST",
      );
      expect(posts).toHaveLength(1);
      expect(posts[0]!.body).toEqual({ step: "orient.v6", thinking: "high" });
    });
  });

  it("disables the reasoning control for a model that has no levels", async () => {
    stubModels();
    await openIntelligence();
    // Haiku 3.5 predates extended thinking. A dropdown of levels here would be
    // a control that silently does nothing — the defect, moved.
    const thinking = screen.getByLabelText("Critic thinking") as HTMLSelectElement;
    expect(thinking.disabled).toBe(true);
    expect([...thinking.options].map((o) => o.textContent)).toEqual(["no thinking levels"]);
  });
});

// ---------------------------------------------------------------------------
// Defect 5b — the embedding registry
// ---------------------------------------------------------------------------

describe("Settings › Intelligence — embedding models", () => {
  it("gives an absent model a Download button and a present one a Delete button", async () => {
    stubModels();
    await openIntelligence();
    expect(screen.getByRole("button", { name: "Download EmbeddingGemma 300M · 768d" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Delete Multilingual E5 Base · 768d" }),
    ).toBeTruthy();
    // The active one is never deletable, and neither is the bundled one.
    expect(
      screen.queryByRole("button", { name: /Delete Multilingual E5 Small/ }),
    ).toBeNull();
  });

  it("marks the active model, names the default, and shows size on disk", async () => {
    stubModels();
    await openIntelligence();
    const row = document.querySelector(`[data-model-row="${E5_SMALL}"]`)!;
    expect(within(row as HTMLElement).getByText("active")).toBeTruthy();
    expect(within(row as HTMLElement).getByText(/129 MB on disk/)).toBeTruthy();

    const gemma = document.querySelector(`[data-model-row="${GEMMA}"]`)! as HTMLElement;
    // EmbeddingGemma is the DEFAULT now, not merely "recommended".
    expect(within(gemma).getByText("default")).toBeTruthy();
    expect(within(gemma).getByText(/315 MB download/)).toBeTruthy();
  });

  it("Download actually POSTs the download route", async () => {
    const stub = stubModels();
    await openIntelligence();
    fireEvent.click(screen.getByRole("button", { name: "Download EmbeddingGemma 300M · 768d" }));
    await waitFor(() => {
      const posts = stub.calls.filter(
        (c) => c.path === "/api/retrieval/semantic/models/download" && c.method === "POST",
      );
      expect(posts).toHaveLength(1);
      expect(posts[0]!.body).toEqual({ id: GEMMA });
    });
  });

  it("shows live progress and a Cancel while a fetch is in flight", async () => {
    const stub = stubModels();
    const models = (embeddingRegistry().models as Record<string, unknown>[]).map((m) =>
      m.id === GEMMA
        ? {
            ...m,
            download: {
              modelId: GEMMA,
              status: "downloading",
              receivedBytes: 104_857_600,
              totalBytes: 330_000_000,
              file: "onnx/model_quantized.onnx_data",
              error: null,
            },
          }
        : m,
    );
    stub.routes.set("/api/retrieval/semantic/models", embeddingRegistry({ models }));
    await openIntelligence();
    await waitFor(() => expect(screen.getByText(/downloading 100 MB of 315 MB/)).toBeTruthy());
    expect(screen.getByText(/model_quantized.onnx_data/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Cancel" })).toHaveLength(1);
  });

  it("renders a failed download with the reason and offers Retry", async () => {
    const stub = stubModels();
    const models = (embeddingRegistry().models as Record<string, unknown>[]).map((m) =>
      m.id === GEMMA
        ? {
            ...m,
            download: {
              modelId: GEMMA,
              status: "error",
              receivedBytes: 12,
              totalBytes: 330_000_000,
              error: "the download server answered 503 Service Unavailable",
            },
          }
        : m,
    );
    stub.routes.set("/api/retrieval/semantic/models", embeddingRegistry({ models }));
    await openIntelligence();
    await waitFor(() =>
      expect(screen.getByText(/503 Service Unavailable/)).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: "Download EmbeddingGemma 300M · 768d" }).textContent).toBe(
      "Retry",
    );
  });

  it("surfaces a refusal from the server rather than a row that did not change", async () => {
    const stub = stubModels();
    stub.routes.set("/api/retrieval/semantic/models/delete", {
      ...embeddingRegistry(),
      error: "that is the model the index is built on — switch to another one first",
    });
    await openIntelligence();
    fireEvent.click(screen.getByRole("button", { name: "Delete Multilingual E5 Base · 768d" }));
    await waitFor(() =>
      expect(screen.getByText(/the model the index is built on/)).toBeTruthy(),
    );
  });
});

// ---------------------------------------------------------------------------
// Defect 7 — the whisper registry
// ---------------------------------------------------------------------------

describe("Settings › Enrichment — whisper models", () => {
  it("is a list with sizes and controls, not a dropdown of names", async () => {
    stubModels();
    await openEnrichment();
    expect(screen.getByRole("button", { name: "Download Tiny" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete Large v3 turbo" })).toBeTruthy();
    // 1.6 GB sitting on the disk, and now visible as such.
    expect(screen.getByText(/1.51 GB on disk/)).toBeTruthy();
    expect(screen.getByText(/74 MB download/)).toBeTruthy();
    expect(screen.getByText(/downloads live in/)).toBeTruthy();
  });

  it("marks the model in use and refuses to offer it for deletion", async () => {
    stubModels();
    await openEnrichment();
    const row = document.querySelector('[data-model-row="large-v3-turbo-q5_0"]')! as HTMLElement;
    // large-v3-turbo-q5_0 stays the default, and it ships inside the app.
    expect(within(row).getByText("in use")).toBeTruthy();
    expect(within(row).getByText("bundled")).toBeTruthy();
    expect(within(row).getByText("in the app")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Delete Large v3 turbo \(q5_0\)/ })).toBeNull();
  });

  it("Delete POSTs the delete route", async () => {
    const stub = stubModels();
    await openEnrichment();
    fireEvent.click(screen.getByRole("button", { name: "Delete Large v3 turbo" }));
    await waitFor(() => {
      const posts = stub.calls.filter(
        (c) => c.path === "/api/media/models/delete" && c.method === "POST",
      );
      expect(posts).toHaveLength(1);
      expect(posts[0]!.body).toEqual({ id: "large-v3-turbo" });
    });
  });

  it("switching to a downloaded model goes through the media setting", async () => {
    const stub = stubModels();
    await openEnrichment();
    fireEvent.click(screen.getByRole("button", { name: "Use" }));
    await waitFor(() => {
      const posts = stub.calls.filter(
        (c) => c.path === "/api/settings/media" && c.method === "POST",
      );
      expect(posts).toHaveLength(1);
      expect(posts[0]!.body).toEqual({ whisper_model: "large-v3-turbo" });
    });
  });

  it("a failed whisper download shows the server's reason on its own row", async () => {
    const stub = stubModels();
    const models = (mediaTools().models as Record<string, unknown>[]).map((m) =>
      m.id === "tiny"
        ? {
            ...m,
            download: {
              id: "tiny",
              status: "error",
              receivedBytes: 0,
              totalBytes: null,
              error: "the download stopped early — 12 of 77691713 bytes",
            },
          }
        : m,
    );
    stub.routes.set("/api/media/tools", mediaTools({ models }));
    await openEnrichment();
    await waitFor(() => expect(screen.getByText(/stopped early/)).toBeTruthy());
  });
});
