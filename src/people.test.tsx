// ===========================================================================
// People view + remaining modals — build P4.2 component tests.
//
// CIR-04 (UI half): dragging a person between circle groups posts
// {type:"set_circle", circle} to /api/corrections — the one pipeline — and
// surfaces the undo chip. FIX-03 (UI half): the person card's circle control
// fires the same structured correction; the Claim modal shows the supersede
// history and its Not true / Outdated chips fire claim corrections. The
// Prepared-artifact modal renders the generative body through the §14.5
// renderer with the three actions. Worker-side halves (mutation + decision +
// eval draft) live in worker/src/server/corrections-routes.test.ts.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { People } from "./screens/People";
import { ClaimModal } from "./modals/ClaimModal";
import { ArtifactModal, artifactResult } from "./modals/ArtifactModal";
import { stubWorker, type WorkerStub } from "./test-utils";
import type { ArtifactRow, ClaimRow, PersonRow } from "./lib/api";

const priya: PersonRow = {
  id: "ent_priya",
  name: "Priya",
  subtype: null,
  circle: "friends",
  provisional: 0,
  user_pinned: 0,
  first_seen_at: "2026-01-01",
  last_seen_at: "2026-08-27",
  created_at: "2026-01-01",
};

const landlord: PersonRow = {
  ...priya,
  id: "ent_landlord",
  name: "Priya's landlord",
  circle: null,
  provisional: 1,
};

let stub: WorkerStub;

beforeEach(() => {
  stub = stubWorker();
  stub.routes.set("/api/people", { people: [priya, landlord], open_questions: [] });
  stub.routes.set("/api/people/ent_priya/claims", {
    subject: "ent_priya",
    circle: "friends",
    claims: [
      {
        id: "clv1",
        claimKey: "person.priya.gym",
        kind: "habit",
        text: "gym at 7am",
        confidence: 0.8,
        statedAt: "2026-08-01",
        validFrom: null,
        validTo: null,
        evidence: [{ quote: "gym chalein 7 baje?", event_ids: ["e1"] }],
      },
    ],
    edges: [],
  });
  stub.routes.set("/api/people/ent_landlord/claims", {
    subject: "ent_landlord",
    circle: null,
    claims: [],
    edges: [],
  });
  stub.routes.set("/api/tone", {
    profile: { register: "short", languageMix: "Hinglish", emojiHabits: "🔥-heavy", notes: null },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("People view (spec §7.3 / §14.4.1)", () => {
  it("groups people into circles, provisional flagged", async () => {
    render(<People />);
    await waitFor(() => screen.getByLabelText("person Priya"));
    const friends = screen.getByLabelText("circle friends");
    expect(within(friends).getByText("Priya")).toBeTruthy();
    const unassigned = screen.getByLabelText("circle no circle yet");
    expect(within(unassigned).getByText("Priya's landlord")).toBeTruthy();
    expect(within(unassigned).getByText("provisional")).toBeTruthy();
  });

  it("CIR-04: drag between circles posts set_circle through the corrections pipeline + undo chip", async () => {
    render(<People />);
    await waitFor(() => screen.getByLabelText("person Priya"));

    fireEvent.dragStart(screen.getByLabelText("person Priya"));
    const closeFriends = screen.getByLabelText("circle close friends");
    fireEvent.dragOver(closeFriends);
    expect(closeFriends.className).toContain("drop-target");
    fireEvent.drop(closeFriends);

    await waitFor(() => {
      const post = stub.calls.find((c) => c.path === "/api/corrections" && c.method === "POST");
      expect(post).toBeTruthy();
      expect(post!.body).toEqual({
        target: { kind: "person", id: "ent_priya" },
        structured: { type: "set_circle", circle: "close_friends" },
      });
    });
    // Undo chip — direct manipulation is a correction, confirmed, reversible.
    await waitFor(() => screen.getByRole("status"));
    fireEvent.click(within(screen.getByRole("status")).getByText("undo"));
    await waitFor(() =>
      expect(stub.calls.some((c) => c.path === "/api/corrections/cor1/undo")).toBe(true),
    );
  });

  it("dropping on the person's own circle posts nothing", async () => {
    render(<People />);
    await waitFor(() => screen.getByLabelText("person Priya"));
    fireEvent.dragStart(screen.getByLabelText("person Priya"));
    fireEvent.drop(screen.getByLabelText("circle friends"));
    expect(stub.calls.filter((c) => c.path === "/api/corrections")).toHaveLength(0);
  });

  it("opens the Person modal: claims with evidence, tone line, circle control fires set_circle", async () => {
    render(<People />);
    await waitFor(() => screen.getByLabelText("person Priya"));
    fireEvent.click(screen.getByLabelText("person Priya"));

    const dialog = await screen.findByRole("dialog", { name: "Priya" });
    await waitFor(() => expect(within(dialog).getByText(/gym at 7am/)).toBeTruthy());
    expect(within(dialog).getByText(/gym chalein 7 baje\?/)).toBeTruthy();
    expect(within(dialog).getByText(/Hinglish, short, 🔥-heavy — used for drafts/)).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText("circle"), {
      target: { value: "close_friends" },
    });
    await waitFor(() => {
      const post = stub.calls.find((c) => c.path === "/api/corrections" && c.method === "POST");
      expect((post!.body as { structured: unknown }).structured).toEqual({
        type: "set_circle",
        circle: "close_friends",
      });
    });
  });

  it("provisional person shows the link-a-contact hint", async () => {
    render(<People />);
    await waitFor(() => screen.getByLabelText("person Priya's landlord"));
    fireEvent.click(screen.getByLabelText("person Priya's landlord"));
    const dialog = await screen.findByRole("dialog", { name: "Priya's landlord" });
    expect(within(dialog).getByText("no contact info — link a contact?")).toBeTruthy();
  });
});

describe("Claim modal (spec §14.6)", () => {
  const claim: ClaimRow = {
    id: "clv2",
    claim_key: "person.riya.relationship",
    kind: "relationship",
    text: "cousin",
    confidence: 1,
    stated_at: "2026-08-27",
    evidence_json: null,
  };

  beforeEach(() => {
    stub.routes.set("/api/claims/person.riya.relationship", {
      claim_key: "person.riya.relationship",
      active: {
        id: "clv2",
        claimKey: "person.riya.relationship",
        kind: "relationship",
        text: "cousin",
        confidence: 1,
        statedAt: "2026-08-27",
        validFrom: "2026-08-27",
        validTo: null,
        evidence: [{ quote: "she's my cousin, not a coworker", event_ids: [] }],
      },
      history: [
        {
          id: "clv2",
          claimKey: "person.riya.relationship",
          kind: "relationship",
          text: "cousin",
          confidence: 1,
          statedAt: "2026-08-27",
          validFrom: "2026-08-27",
          validTo: null,
        },
        {
          id: "clv1",
          claimKey: "person.riya.relationship",
          kind: "relationship",
          text: "coworker",
          confidence: 0.7,
          statedAt: "2026-08-10",
          validFrom: null,
          validTo: "2026-08-27",
          closedBy: "user",
        },
      ],
    });
  });

  it("FIX-03 surface: shows the supersede history — the old claim kept with a validity end", async () => {
    const onCorrection = vi.fn();
    render(
      <ClaimModal claim={claim} onCorrection={onCorrection} onTellTwin={() => {}} onClose={() => {}} />,
    );
    const dialog = await screen.findByRole("dialog", { name: "cousin" });
    await waitFor(() =>
      expect(within(dialog).getByText(/replaced “coworker” — Aug 2026/)).toBeTruthy(),
    );
    expect(within(dialog).getByText(/conf 1\.00 · valid Aug 2026 → open/)).toBeTruthy();
    expect(within(dialog).getByText(/she's my cousin, not a coworker/)).toBeTruthy();
  });

  it("Not true / Outdated chips fire the structured claim corrections", async () => {
    const onCorrection = vi.fn();
    render(
      <ClaimModal claim={claim} onCorrection={onCorrection} onTellTwin={() => {}} onClose={() => {}} />,
    );
    const dialog = await screen.findByRole("dialog", { name: "cousin" });
    fireEvent.click(within(dialog).getByText("Not true"));
    expect(onCorrection).toHaveBeenCalledWith({ type: "not_true" });
    fireEvent.click(within(dialog).getByText("Outdated"));
    expect(onCorrection).toHaveBeenCalledWith({ type: "outdated" });
  });
});

describe("Prepared-artifact modal (spec §14.6)", () => {
  const artifact: ArtifactRow = {
    id: "art1",
    kind: "comparison",
    title: "Villa comparison",
    summary: "3 fit budget",
    bodyJson: JSON.stringify({
      result_type: "comparison_table",
      data: {
        columns: ["villa", "price"],
        rows: [["Villa Sol", "₹5.4k"]],
        recommendation: "Villa Sol — best fit",
      },
    }),
    intent: "Saw you comparing Anjuna villas — prepared this.",
    reasoning: "built from 3 sites + your budget claim",
    spaceId: "sp_goa",
    taskId: null,
    topicKey: "villas",
    producer: "assist",
    status: "seen",
    nudgedAt: null,
    seenAt: "2026-08-28",
    dismissedAt: null,
    expiresAt: null,
    createdAt: "2026-08-28",
  };

  it("renders intent, the generative artifact full-size, provenance, and the three actions", () => {
    const onGraduate = vi.fn();
    const onDismiss = vi.fn();
    const onIterate = vi.fn();
    render(
      <ArtifactModal
        artifact={artifact}
        onGraduate={onGraduate}
        onDismiss={onDismiss}
        onIterate={onIterate}
        onClose={() => {}}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Villa comparison" });
    expect(within(dialog).getByText("Saw you comparing Anjuna villas — prepared this.")).toBeTruthy();
    // The body renders through the SAME §14.5 renderer as executor results.
    const region = within(dialog).getByTestId("result-region");
    expect(region.textContent).toContain("Villa Sol");
    expect(region.textContent).toContain("← Villa Sol — best fit");
    expect(within(dialog).getByText(/built from 3 sites \+ your budget claim/)).toBeTruthy();

    fireEvent.click(within(dialog).getByText("Make it a task"));
    expect(onGraduate).toHaveBeenCalled();
    fireEvent.click(within(dialog).getByText("Iterate…"));
    expect(onIterate).toHaveBeenCalled();
    fireEvent.click(within(dialog).getByText("Discard"));
    expect(onDismiss).toHaveBeenCalled();
  });

  it("artifactResult: a non-envelope body still gets the document card; broken JSON gets none", () => {
    expect(artifactResult({ ...artifact, bodyJson: JSON.stringify({ note: "hi" }) })).toEqual({
      result_type: "document",
      data: { note: "hi" },
    });
    expect(artifactResult({ ...artifact, bodyJson: "{broken" })).toBeNull();
    expect(artifactResult({ ...artifact, bodyJson: null })).toBeNull();
  });
});
