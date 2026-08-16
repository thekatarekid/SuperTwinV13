// §14.0b rule 3, as tests: a provisional item may change or disappear, and the
// surface must say so rather than rewriting history under the reader.

import { describe, expect, it } from "vitest";

import {
  dismissRetracted,
  livingRows,
  retainProvisional,
  type Retained,
} from "./provisional";

interface Row {
  id: string;
  label: string;
  open: boolean;
}

const row = (id: string, open: boolean, label = id): Row => ({ id, label, open });
const isProvisional = (r: Row) => r.open;
const wrap = (rows: Row[]): Retained<Row>[] => rows.map((r) => ({ row: r, retracted: false }));

describe("retainProvisional", () => {
  it("takes the fresh copy and the fresh order (§14.0b rule 2 — update in place)", () => {
    const before = wrap([row("a", true), row("b", false)]);
    const after = retainProvisional(before, [row("b", false), row("a", true, "renamed")], isProvisional);

    expect(after.map((e) => e.row.id)).toEqual(["b", "a"]);
    expect(after[1].row.label).toBe("renamed");
    expect(after.every((e) => !e.retracted)).toBe(true);
  });

  it("keeps a vanished PROVISIONAL row, marked, with its last known content", () => {
    const before = wrap([row("a", true, "villa link"), row("b", false)]);
    const after = retainProvisional(before, [row("b", false)], isProvisional);

    expect(after).toHaveLength(2);
    const lost = after.find((e) => e.row.id === "a");
    expect(lost?.retracted).toBe(true);
    expect(lost?.row.label).toBe("villa link");
  });

  it("does NOT keep a vanished settled row — that is a filter change, not a retraction", () => {
    const before = wrap([row("a", true), row("b", false)]);
    const after = retainProvisional(before, [row("a", true)], isProvisional);

    expect(after.map((e) => e.row.id)).toEqual(["a"]);
  });

  it("un-retracts a row that comes back", () => {
    const gone = retainProvisional(wrap([row("a", true)]), [], isProvisional);
    expect(gone[0].retracted).toBe(true);

    const back = retainProvisional(gone, [row("a", true)], isProvisional);
    expect(back).toHaveLength(1);
    expect(back[0].retracted).toBe(false);
  });

  it("keeps a retracted row retracted across further polls (it never re-appears to vanish again)", () => {
    const once = retainProvisional(wrap([row("a", true)]), [], isProvisional);
    const twice = retainProvisional(once, [row("b", false)], isProvisional);

    expect(twice.map((e) => [e.row.id, e.retracted])).toEqual([
      ["b", false],
      ["a", true],
    ]);
  });

  it("drops a retracted row only when the reader dismisses it", () => {
    const list = retainProvisional(wrap([row("a", true)]), [], isProvisional);
    expect(dismissRetracted(list, "a")).toHaveLength(0);
  });

  it("will not dismiss a row that is still live", () => {
    const list = wrap([row("a", true)]);
    expect(dismissRetracted(list, "a")).toHaveLength(1);
  });

  it("counts only living rows", () => {
    const list = retainProvisional(wrap([row("a", true), row("b", false)]), [row("b", false)], isProvisional);
    expect(livingRows(list).map((r) => r.id)).toEqual(["b"]);
  });
});
