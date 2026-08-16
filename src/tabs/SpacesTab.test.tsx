// The Spaces surface (arch §14.6, build item 3.10).
//
// What this file is really testing:
//
//  1. ONE CARD LAYOUT, EIGHT ARCHETYPES — differentiated by icon, accent class
//     and the worker's signal strip, and by nothing structural.
//  2. `[ why a space? ]` RENDERS THE ROUTE AND THE LOOPS. A promotion nobody
//     can explain is not shippable.
//  3. CONTEXT CLAIMS ARE COMPUTED AT QUERY TIME, preferences weighted first,
//     and the surface says so on the card.
//  4. AN ARC WITH NO LIVE LOOP IS NOT A SPACE — it is browsable, with a reason.
//  5. A USER GESTURE WINS PERMANENTLY (§14.8) and writes a mutation receipt.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { SpacesTab } from "./SpacesTab";
import { ARCHETYPES, type SpaceView, type SpacesClient, type SpacesPage } from "../lib/spaces-client";
import type { MutationReceipt } from "../lib/surfaces-client";

afterEach(cleanup);

const receipt: MutationReceipt = {
  mutationId: "mut_9",
  actor: "user",
  targetKind: "arc",
  targetId: "arc_77",
  field: "archetype",
};

const goa: SpaceView = {
  id: "arc_77",
  arcId: "arc_77",
  label: "Goa trip",
  labelSource: "model",
  archetype: "evt",
  archetypeSource: "model",
  status: "active",
  promotionReason: "cmt",
  signalStrip: "⏳ 31 days",
  pinned: false,
  dormantNote: null,
  stillGrowing: false,
  provisional: false,
  endsAt: "2026-09-15",
  cadence: null,
  loops: [
    {
      id: "loop_1",
      intent: "confirm villa to Rohan",
      state: "open",
      dueAt: "2026-08-20",
      ownerLabel: "you",
      ownerIsSelf: true,
    },
    {
      id: "loop_2",
      intent: "hold the villa till 20 Aug",
      state: "open",
      dueAt: null,
      ownerLabel: "Rohan",
      ownerIsSelf: false,
    },
  ],
  people: [
    { id: "ent_1", label: "Rohan" },
    { id: "ent_2", label: "Ana" },
  ],
  sources: ["whatsapp", "gmail"],
  contextClaims: [
    { claimId: "clm_b", kind: "fact", text: "Budget ₹40k each.", confidence: 0.95, weighted: false },
    { claimId: "clm_a", kind: "preference", text: "Ana is vegetarian.", confidence: 0.9, weighted: true },
  ],
  promotionRule: "a commitment with a due date bound two sources",
  promotingLoopIds: ["loop_1"],
};

const broadband: SpaceView = {
  ...goa,
  id: "arc_88",
  arcId: "arc_88",
  label: "Broadband renewal",
  archetype: "adm",
  status: "dormant",
  dormantNote: "quiet 9d",
  stillGrowing: true,
  signalStrip: "₹1,499 due 28 Aug · ACT · unpaid",
  endsAt: null,
  promotionReason: "rec",
  contextClaims: [],
  loops: [],
  promotingLoopIds: [],
  promotionRule: null,
};

const live: SpaceView = { ...goa, id: "arc_99", arcId: "arc_99", label: "Dinner plan", provisional: true };

function page(spaces: SpaceView[]): SpacesPage {
  return {
    counts: { active: 14, dormant: 9, archived: 22 },
    spaces,
    notSpaces: [{ arcId: "arc_12", label: "pets and animals discussion", reason: "no live loop" }],
    lifeProjects: [
      {
        id: "goal_1",
        name: "Move near Indiranagar by Dec 2026",
        spaceIds: ["arc_77", "arc_88"],
        spaceLabels: ["Housing search", "Lease exit"],
        emerged: true,
      },
    ],
  };
}

function makeClient(over: Partial<SpacesClient> = {}): SpacesClient {
  return {
    getCoverage: vi.fn(async () => ({ mode: "steady" as const, rows: [] })),
    listSpaces: vi.fn(async () => page([goa, broadband])),
    setArchetype: vi.fn(async () => receipt),
    relabelSpace: vi.fn(async () => receipt),
    pinSpace: vi.fn(async () => receipt),
    archiveSpace: vi.fn(async () => receipt),
    listGoals: vi.fn(async () => []),
    ...over,
  };
}

const card = (id: string) => document.querySelector(`[data-space-id="${id}"]`) as HTMLElement;

function renderTab(client: SpacesClient, onOpenThreads?: () => void) {
  return render(<SpacesTab client={client} coveragePollMs={0} onOpenThreads={onOpenThreads} />);
}

describe("one card layout, eight archetypes", () => {
  it("differentiates with icon, accent class and the worker's signal strip", async () => {
    renderTab(makeClient());
    await screen.findByText("Goa trip");

    const evt = card("arc_77");
    expect(evt.className).toContain("space--evt");
    expect(evt.dataset.archetype).toBe("evt");
    expect(within(evt).getByText("⏳ 31 days")).toBeTruthy();
    expect(within(evt).getByText("EVENT")).toBeTruthy();

    const adm = card("arc_88");
    expect(adm.className).toContain("space--adm");
    expect(within(adm).getByText("₹1,499 due 28 Aug · ACT · unpaid")).toBeTruthy();
  });

  it("gives every archetype a distinct accent class", async () => {
    renderTab(
      makeClient({
        listSpaces: vi.fn(async () =>
          page(ARCHETYPES.map((a, i) => ({ ...goa, id: `arc_${i}`, arcId: `arc_${i}`, archetype: a }))),
        ),
      }),
    );
    await screen.findAllByText("Goa trip");
    const classes = ARCHETYPES.map((_, i) => card(`arc_${i}`).className);
    for (const [i, a] of ARCHETYPES.entries()) expect(classes[i]).toContain(`space--${a}`);
  });

  it("shows the §14.6 markers, using the worker's dormancy phrasing", async () => {
    renderTab(makeClient());
    await screen.findByText("Broadband renewal");
    expect(within(card("arc_88")).getByText(/💤 quiet 9d · ◍ still growing/)).toBeTruthy();
  });

  it("prints the arc id on every card — a space IS an arc", async () => {
    renderTab(makeClient());
    await screen.findByText("Goa trip");
    expect(within(card("arc_77")).getByText(/arc: arc_77/)).toBeTruthy();
  });
});

describe("[ why a space? ]", () => {
  it("renders the promotion rule and the loops that caused it", async () => {
    renderTab(makeClient());
    await screen.findByText("Goa trip");
    const evt = card("arc_77");
    fireEvent.click(within(evt).getByRole("button", { name: "why a space?" }));
    expect(within(evt).getByText("a commitment with a due date bound two sources")).toBeTruthy();
    expect(within(evt).getByText("confirm villa to Rohan (loop_1)")).toBeTruthy();
  });

  it("says so when no rule was recorded, rather than showing an empty panel", async () => {
    renderTab(makeClient());
    await screen.findByText("Broadband renewal");
    const adm = card("arc_88");
    fireEvent.click(within(adm).getByRole("button", { name: "why a space?" }));
    expect(within(adm).getByText("no promotion rule recorded")).toBeTruthy();
    expect(within(adm).getByText("no promoting loop recorded")).toBeTruthy();
  });
});

describe("context claims", () => {
  it("puts preferences first and labels the ordering rule", async () => {
    renderTab(makeClient());
    await screen.findByText("Goa trip");
    const context = card("arc_77").querySelector(".space__context") as HTMLElement;
    const texts = [...context.querySelectorAll(".space__claim-text")].map((n) => n.textContent);
    expect(texts).toEqual(["Ana is vegetarian.", "Budget ₹40k each."]);
    expect(within(context).getByText(/computed at query time — not stored on the space/)).toBeTruthy();
    expect(within(context).getByText("preference, weighted first")).toBeTruthy();
  });
});

describe("loops on the card show whose they are", () => {
  it("marks your loops and names the other person's", async () => {
    renderTab(makeClient());
    await screen.findByText("Goa trip");
    const evt = card("arc_77");
    expect(within(evt).getByText("● you")).toBeTruthy();
    expect(within(evt).getByText("○ Rohan")).toBeTruthy();
  });
});

describe("not a space", () => {
  it("lists unpromoted arcs with a reason and links to Threads", async () => {
    const onOpenThreads = vi.fn();
    renderTab(makeClient(), onOpenThreads);
    await screen.findByText("pets and animals discussion");
    expect(screen.getByText("no live loop")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "view all threads" }));
    expect(onOpenThreads).toHaveBeenCalled();
  });

  it("renders a life project as a link between spaces, not as a ninth archetype", async () => {
    renderTab(makeClient());
    await screen.findByText("Move near Indiranagar by Dec 2026");
    expect(screen.getByText("emerged, 2 spaces")).toBeTruthy();
    expect(document.querySelector('[data-space-id="goal_1"]')).toBeNull();
  });
});

describe("gestures (§14.8)", () => {
  it("an archetype override writes a mutation and says the model never reverts it", async () => {
    const client = makeClient();
    renderTab(client);
    await screen.findByText("Goa trip");
    const evt = card("arc_77");
    expect(within(evt).getByText(/the model never reverts them/)).toBeTruthy();
    fireEvent.change(within(evt).getByLabelText("Archetype for Goa trip"), {
      target: { value: "prj" },
    });
    await waitFor(() =>
      expect(client.setArchetype).toHaveBeenCalledWith({ id: "arc_77", archetype: "prj", actor: "user" }),
    );
    expect(await screen.findByText(/mutation mut_9/)).toBeTruthy();
  });

  it("relabel sends the user's own label", async () => {
    const client = makeClient();
    renderTab(client);
    await screen.findByText("Goa trip");
    const evt = card("arc_77");
    fireEvent.click(within(evt).getByRole("button", { name: "relabel" }));
    fireEvent.change(within(evt).getByLabelText("New label for Goa trip"), {
      target: { value: "Goa, September" },
    });
    fireEvent.click(within(evt).getByRole("button", { name: "save" }));
    await waitFor(() =>
      expect(client.relabelSpace).toHaveBeenCalledWith({
        id: "arc_77",
        label: "Goa, September",
        actor: "user",
      }),
    );
  });
});

describe("provisional and chrome", () => {
  it("marks a live space and keeps it, struck through, when it stops being one", async () => {
    const listSpaces = vi
      .fn<SpacesClient["listSpaces"]>()
      .mockResolvedValueOnce(page([goa, live]))
      .mockResolvedValue(page([goa]));
    renderTab(makeClient({ listSpaces }));
    await screen.findByText("Dinner plan");
    expect(screen.getByText(/this space may still change/)).toBeTruthy();

    fireEvent.click(within(card("arc_77")).getByRole("button", { name: "pin" }));
    expect(await screen.findByText(/no longer a space/)).toBeTruthy();
    expect(screen.getByText("Dinner plan")).toBeTruthy();
  });

  it("carries the coverage meter, like all eight surfaces", async () => {
    const client = makeClient();
    renderTab(client);
    await waitFor(() => expect(client.getCoverage).toHaveBeenCalled());
  });

  it("reports a failed read", async () => {
    renderTab(makeClient({ listSpaces: vi.fn(async () => { throw new Error("nope"); }) }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "nope");
  });
});
