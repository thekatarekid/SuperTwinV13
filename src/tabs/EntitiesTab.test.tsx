// The Entities surface (arch §14.1, build item 1.11).
//
// The load-bearing test in this file is the gesture one: every gesture must
// write `mutations(actor:user)`. It is asserted on all six gestures rather than
// on one, because "the merge button forgot the actor" is precisely the bug that
// makes an audit trail useless and that no other test would catch.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { EntitiesTab } from "./EntitiesTab";
import type {
  EntitiesPage,
  EntityView,
  MutationReceipt,
  ResolutionQueueItem,
  SurfacesClient,
} from "../lib/surfaces-client";

afterEach(cleanup);

let seq = 0;
const receipt = (field: string, targetId: string): MutationReceipt => ({
  mutationId: `mut_${++seq}`,
  actor: "user",
  targetKind: "entity",
  targetId,
  field,
});

const pranjali: EntityView = {
  id: "ent_1",
  type: "person",
  subtype: null,
  label: "Pranjali Sachdeva",
  provisional: false,
  pinned: false,
  firstSeenAt: "2025-03-12T09:00:00.000Z",
  identities: [
    {
      id: "idn_1",
      kind: "jid",
      value: "9177…03",
      sourceId: "whatsapp",
      confidence: 1,
      decidedBy: "code:exact",
    },
    {
      id: "idn_2",
      kind: "handle",
      value: "@pran",
      sourceId: "slack",
      confidence: 0.71,
      decidedBy: "ml",
    },
  ],
  relations: [
    {
      edgeId: "edg_1",
      kind: "affiliated_with",
      subtype: "member",
      direction: "out",
      otherId: "ent_2",
      otherLabel: "Ghar+",
      confidence: 1,
      decidedBy: "code:group",
      status: "active",
      evidence: [{ eventId: "ev_1", quote: "added Pranjali to Ghar+" }],
    },
  ],
  counts: { sessions: 41, episodes: 12, arcs: 3 },
  needsResolution: false,
};

const ghar: EntityView = {
  ...pranjali,
  id: "ent_2",
  type: "group",
  label: "Ghar+",
  identities: [],
  relations: [],
  counts: { sessions: 9, episodes: 2, arcs: 0 },
};

const page = (entities: EntityView[] = [pranjali, ghar]): EntitiesPage => ({
  counts: { person: 132, group: 9, org: 14 },
  unresolvedCount: 12,
  entities,
});

const question: ResolutionQueueItem = {
  id: "qst_1",
  left: { id: "ent_3", label: "Papa (new number Jio)" },
  right: { id: "ent_4", label: "Papa" },
  agentVerdict: "same",
  confidence: 0.88,
  reasoning: "same group, same address term, old number went silent",
  askedAt: "2025-08-14T10:00:00.000Z",
};

function makeClient(over: Partial<SurfacesClient> = {}) {
  const client = {
    getCoverage: vi.fn(async () => ({
      mode: "bootstrap" as const,
      rows: [{ horizon: "d30" as const, totalUnits: 800, doneUnits: 568 }],
      pausedLabel: null,
      remainingMinutes: 14,
    })),
    listEntities: vi.fn(async () => page()),
    listResolutionQueue: vi.fn(async (): Promise<ResolutionQueueItem[]> => []),
    mergeEntity: vi.fn(async (p: { id: string }) => receipt("merge", p.id)),
    splitEntity: vi.fn(async (p: { id: string }) => receipt("split", p.id)),
    renameEntity: vi.fn(async (p: { id: string }) => receipt("canonical", p.id)),
    pinEntity: vi.fn(async (p: { id: string }) => receipt("user_pinned", p.id)),
    addRelation: vi.fn(async (p: { id: string }) => receipt("edge", p.id)),
    rejectEdge: vi.fn(async (p: { edgeId: string }) => receipt("status", p.edgeId)),
    answerResolution: vi.fn(async (p: { id: string }) => receipt("verdict", p.id)),
    listSessions: vi.fn(),
    getSegmentation: vi.fn(),
    saveSegmentation: vi.fn(),
    replaySegmentation: vi.fn(),
    applySegmentation: vi.fn(),
    ...over,
  } as unknown as SurfacesClient;
  return client;
}

const mount = (client: SurfacesClient) =>
  render(<EntitiesTab client={client} coveragePollMs={0} />);

/**
 * The card for one entity. Selected by id rather than by name: an entity's own
 * label also appears inside its relation graph ("Pranjali ──▶ Ghar+"), so a
 * name is not unique within the surface.
 */
async function card(entityId = "ent_1"): Promise<HTMLElement> {
  let found: HTMLElement | null = null;
  await waitFor(() => {
    found = document.querySelector(`[data-entity-id="${entityId}"]`);
    expect(found).toBeTruthy();
  });
  return found as unknown as HTMLElement;
}

describe("Entities surface — what it shows", () => {
  it("carries the coverage meter, like every surface (§14.0)", async () => {
    mount(makeClient());
    await waitFor(() => expect(screen.getByLabelText("Understanding your history")).toBeTruthy());
  });

  it("offers type filters with counts, a search box and an unresolved filter", async () => {
    mount(makeClient());
    expect(await screen.findByRole("button", { name: "person 132" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "group 9" })).toBeTruthy();
    expect(screen.getByLabelText("Search entities")).toBeTruthy();
    expect(screen.getByRole("button", { name: /12 need resolution/ })).toBeTruthy();
  });

  it("shows decided_by AND confidence on every identity — no silent guesses", async () => {
    mount(makeClient());
    const entity = await card();
    expect(within(entity).getByText("✓code:exact 1.00")).toBeTruthy();
    expect(within(entity).getByText("⚠ ml 0.71")).toBeTruthy();
  });

  it("labels a relation with its subtype and carries the evidence quote", async () => {
    mount(makeClient());
    const entity = await card();
    expect(within(entity).getByText("affiliated_with:member")).toBeTruthy();
    expect(within(entity).getByText(/added Pranjali to Ghar\+/)).toBeTruthy();
  });

  it("counts sessions, episodes and arcs", async () => {
    mount(makeClient());
    const entity = await card();
    expect(within(entity).getByText(/41 sessions · 12 episodes · 3 arcs/)).toBeTruthy();
  });

  it("filters by type, by search text and by unresolved", async () => {
    const client = makeClient();
    mount(client);
    await screen.findByRole("button", { name: "person 132" });

    fireEvent.click(screen.getByRole("button", { name: "person 132" }));
    await waitFor(() =>
      expect(client.listEntities).toHaveBeenCalledWith(
        expect.objectContaining({ type: "person" }),
        expect.anything(),
      ),
    );

    fireEvent.change(screen.getByLabelText("Search entities"), { target: { value: "pran" } });
    await waitFor(() =>
      expect(client.listEntities).toHaveBeenCalledWith(
        expect.objectContaining({ q: "pran" }),
        expect.anything(),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: /12 need resolution/ }));
    await waitFor(() =>
      expect(client.listEntities).toHaveBeenCalledWith(
        expect.objectContaining({ unresolvedOnly: true }),
        expect.anything(),
      ),
    );
  });
});

describe("Entities gestures — every one writes mutations(actor:user)", () => {
  it("pin", async () => {
    const client = makeClient();
    mount(client);
    const entity = await card();

    fireEvent.click(within(entity).getByRole("button", { name: "pin" }));
    await waitFor(() =>
      expect(client.pinEntity).toHaveBeenCalledWith({ id: "ent_1", pinned: true, actor: "user" }),
    );
    expect(await screen.findByText(/mutation mut_\d+ · actor user/)).toBeTruthy();
  });

  it("rename", async () => {
    const client = makeClient();
    mount(client);
    const entity = await card();

    fireEvent.click(within(entity).getByRole("button", { name: "rename" }));
    fireEvent.change(within(entity).getByLabelText("Rename to"), {
      target: { value: "Pranjali S." },
    });
    fireEvent.click(within(entity).getByRole("button", { name: "confirm rename" }));

    await waitFor(() =>
      expect(client.renameEntity).toHaveBeenCalledWith({
        id: "ent_1",
        canonical: "Pranjali S.",
        actor: "user",
      }),
    );
  });

  it("merge", async () => {
    const client = makeClient();
    mount(client);
    const entity = await card();

    fireEvent.click(within(entity).getByRole("button", { name: "merge" }));
    fireEvent.change(within(entity).getByLabelText("Merge into"), { target: { value: "ent_2" } });
    fireEvent.click(within(entity).getByRole("button", { name: "confirm merge" }));

    await waitFor(() =>
      expect(client.mergeEntity).toHaveBeenCalledWith({
        id: "ent_1",
        into: "ent_2",
        actor: "user",
      }),
    );
  });

  it("split", async () => {
    const client = makeClient();
    mount(client);
    const entity = await card();

    fireEvent.click(within(entity).getByRole("button", { name: "split" }));
    fireEvent.click(within(entity).getByRole("checkbox", { name: /@pran/ }));
    fireEvent.click(within(entity).getByRole("button", { name: "confirm split" }));

    await waitFor(() =>
      expect(client.splitEntity).toHaveBeenCalledWith({
        id: "ent_1",
        identityIds: ["idn_2"],
        actor: "user",
      }),
    );
  });

  it("add relation", async () => {
    const client = makeClient();
    mount(client);
    const entity = await card();

    fireEvent.click(within(entity).getByRole("button", { name: "add relation" }));
    fireEvent.change(within(entity).getByLabelText("Relation"), {
      target: { value: "located_at" },
    });
    fireEvent.change(within(entity).getByLabelText("Subtype"), { target: { value: "current" } });
    fireEvent.change(within(entity).getByLabelText("To"), { target: { value: "ent_9" } });
    fireEvent.click(within(entity).getByRole("button", { name: "confirm relation" }));

    await waitFor(() =>
      expect(client.addRelation).toHaveBeenCalledWith({
        id: "ent_1",
        kind: "located_at",
        subtype: "current",
        dstEntityId: "ent_9",
        actor: "user",
      }),
    );
  });

  it("reject edge", async () => {
    const client = makeClient();
    mount(client);
    const entity = await card();

    fireEvent.click(within(entity).getByRole("button", { name: "reject edge" }));
    await waitFor(() =>
      expect(client.rejectEdge).toHaveBeenCalledWith({ edgeId: "edg_1", actor: "user" }),
    );
  });

  it("reports a failed gesture instead of pretending it was written", async () => {
    const client = makeClient({
      pinEntity: vi.fn(async () => {
        throw new Error("worker offline");
      }),
    });
    mount(client);
    const entity = await card();

    fireEvent.click(within(entity).getByRole("button", { name: "pin" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/pin failed — worker offline/);
    expect(screen.queryByText(/mutation mut/)).toBeNull();
  });
});

describe("the resolution queue", () => {
  it("shows the pair, the agent's verdict and its reasoning verbatim", async () => {
    mount(makeClient({ listResolutionQueue: vi.fn(async () => [question]) }));
    const queue = await screen.findByLabelText("Resolution queue");

    expect(within(queue).getByText(/Papa \(new number Jio\)/)).toBeTruthy();
    expect(within(queue).getByText("agent: same 0.88")).toBeTruthy();
    expect(
      within(queue).getByText(/same group, same address term, old number went silent/),
    ).toBeTruthy();
    expect(within(queue).getByText(/12 waiting|1 waiting/)).toBeTruthy();
  });

  it("answers one pair as the user", async () => {
    const client = makeClient({ listResolutionQueue: vi.fn(async () => [question]) });
    mount(client);
    const queue = await screen.findByLabelText("Resolution queue");

    fireEvent.click(within(queue).getByRole("button", { name: "same" }));
    await waitFor(() =>
      expect(client.answerResolution).toHaveBeenCalledWith({
        id: "qst_1",
        verdict: "same",
        actor: "user",
      }),
    );
  });

  it("'answer all' steps through the pairs — it NEVER answers them in bulk", async () => {
    const second = { ...question, id: "qst_2", left: { id: "ent_5", label: "Nani" } };
    const client = makeClient({ listResolutionQueue: vi.fn(async () => [question, second]) });
    mount(client);
    const queue = await screen.findByLabelText("Resolution queue");

    fireEvent.click(within(queue).getByRole("button", { name: /answer all 2/ }));

    expect(client.answerResolution).not.toHaveBeenCalled();
    expect(within(queue).getByText("1 of 2")).toBeTruthy();
    expect(within(queue).queryByText(/Nani/)).toBeNull();

    fireEvent.click(within(queue).getByRole("button", { name: /next/ }));
    expect(within(queue).getByText(/Nani/)).toBeTruthy();
    expect(client.answerResolution).not.toHaveBeenCalled();
  });
});

describe("provisional entities (§14.0b)", () => {
  const provisional: EntityView = { ...ghar, id: "ent_7", label: "unknown 9198…21", provisional: true };

  it("marks a provisional entity rather than showing it as settled", async () => {
    mount(makeClient({ listEntities: vi.fn(async () => page([pranjali, provisional])) }));
    expect(await screen.findByText("◍ provisional")).toBeTruthy();
  });

  it("keeps a provisional entity that disappears, labelled — never a silent retraction", async () => {
    const listEntities = vi
      .fn()
      .mockResolvedValueOnce(page([pranjali, provisional]))
      .mockResolvedValue(page([pranjali]));
    const client = makeClient({ listEntities });
    mount(client);

    await screen.findByText("unknown 9198…21");

    // Any gesture refreshes the list; the second answer no longer has it.
    fireEvent.click(within(await card()).getByRole("button", { name: "pin" }));

    expect(await screen.findByText(/no longer listed/)).toBeTruthy();
    expect(screen.getByText("unknown 9198…21")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "dismiss" }));
    expect(screen.queryByText("unknown 9198…21")).toBeNull();
  });
});
