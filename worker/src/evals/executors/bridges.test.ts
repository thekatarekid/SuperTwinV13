// ===========================================================================
// The category K executor (build item 2.4): the scenario format, the manifest
// gate reaching the real registry, and the replay claim it reports.
// ===========================================================================

import { describe, expect, it } from "vitest";

import { validateFixture } from "../fixtures.js";
import type { Produced } from "../runner.js";
import { bridgesExecutor } from "./bridges.js";

const FIXTURE = validateFixture(
  {
    id: "K-901",
    category: "K",
    layer: "bridges",
    call: "[CODE]",
    mode: "steady",
    given: { roster: [], streams: [], events: [], open: { episodes: [], loops: [] }, db: { entities: [], claims: [], arcs: [] } },
    frozen_response: "",
    expect: {},
    assert: { mode: "no_throw", gate: "arcs_bridge_recall" },
  },
  "<test>",
);

async function run(response: string): Promise<Produced> {
  return await bridgesExecutor({ fixture: FIXTURE, response, mode: "frozen" });
}

describe("the bridges executor", () => {
  it("joins a chat link to a browser visit, and reports zero model calls", async () => {
    const produced = await run(
      [
        "source|id=browser|keys=url",
        "item|id=e1|source=whatsapp|ts=2026-08-13T18:40:00Z|text=look https://www.site0.com/x?utm_source=wa",
        "item|id=v1|source=browser|ts=2026-08-13T19:00:00Z|urls=https://site0.com/x",
      ].join("\n"),
    );
    expect(produced.output.bridges).toEqual([{ kind: "url", value: "site0.com/x", left: "e1", right: "v1" }]);
    expect(produced.state.model_calls).toBe(0);
    // Bidirectional storage: one bridge, two rows.
    expect(produced.state.rows).toBe(2);
    expect(produced.state.replay_stable).toBe(true);
  });

  it("takes WhatsApp's kinds from the registered manifest, not the scenario", async () => {
    const produced = await run(
      "item|id=e1|source=whatsapp|ts=2026-08-13T18:40:00Z|text=hello|lat=19.0596|lon=72.8295",
    );
    expect(produced.state.live_keys).toEqual(["email", "media_work_id", "order_id", "phone", "url"]);
    expect(produced.state.bridges).toBe(0);
  });

  it("lets a scenario declare the manifest of a source that is not built yet", async () => {
    const produced = await run(
      [
        "source|id=drive|keys=file_id",
        "item|id=d1|source=drive|files=gdrive:1AbCdEfGhIjKlMnOpQr",
        "item|id=e1|source=whatsapp|text=here https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQr/view",
      ].join("\n"),
    );
    expect(produced.state.live_keys).toContain("file_id");
    expect(produced.output.bridges).toEqual([
      { kind: "file_id", value: "gdrive:1AbCdEfGhIjKlMnOpQr", left: "d1", right: "e1" },
    ]);
  });

  it("resolves a shortlink from a declared expansion and never from the network", async () => {
    const produced = await run(
      [
        "source|id=browser|keys=url",
        "expand|from=https://bit.ly/villa|to=https://www.site9.com/villa?utm_source=x",
        "item|id=e1|source=whatsapp|text=https://bit.ly/villa",
        "item|id=v1|source=browser|urls=http://site9.com/villa",
      ].join("\n"),
    );
    expect(produced.output.bridges).toEqual([{ kind: "url", value: "site9.com/villa", left: "e1", right: "v1" }]);
  });

  it("rejects a record it does not know rather than scoring a gate on silence", async () => {
    await expect(run("nonsense|id=1")).rejects.toThrow(/unknown record/);
    await expect(run("source|id=browser|keys=teleport")).rejects.toThrow(/not one of/);
  });
});
