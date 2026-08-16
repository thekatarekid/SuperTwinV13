import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  within,
  fireEvent,
} from "@testing-library/react";
import { act } from "react";
import { SettingsTab, LLM_PARALLEL_NOTE } from "./SettingsTab";
import type {
  LogsInfo,
  MediaQueue,
  MediaSettings,
  MediaToolState,
  ModelInfo,
  QuotaInfo,
  RoleInfo,
  RunListItem,
  SemanticState,
  UsageSummary,
  UsageWindow,
  WhisperModelState,
  WorkerClient,
} from "../lib/worker-client";
import type {
  EmbeddingModelRow,
  EmbeddingRegistry,
} from "../lib/embedding-models-client";

afterEach(cleanup);

// The 11-entry catalog the worker returns, grouped by family in order.
const CATALOG: ModelInfo[] = [
  { id: "", label: "Default (subscription)", family: "Default" },
  { id: "opus", label: "Opus", family: "Opus" },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", family: "Opus" },
  { id: "claude-opus-4-5-20251101", label: "Claude Opus 4.5", family: "Opus" },
  { id: "sonnet", label: "Sonnet", family: "Sonnet" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", family: "Sonnet" },
  {
    id: "claude-sonnet-4-5-20250929",
    label: "Claude Sonnet 4.5",
    family: "Sonnet",
  },
  { id: "haiku", label: "Haiku", family: "Haiku" },
  {
    id: "claude-haiku-4-5-20251001",
    label: "Claude Haiku 4.5",
    family: "Haiku",
  },
  { id: "fable", label: "Fable", family: "Fable" },
  { id: "claude-fable-5", label: "Claude Fable 5", family: "Fable" },
];

// Roles the worker returns, in order: chat, extraction, execution(future).
const ROLES: RoleInfo[] = [
  {
    key: "chat",
    label: "Chat",
    description: "Model for grounded chat answers.",
    future: false,
  },
  {
    key: "extraction",
    label: "Extraction",
    description: "Model that builds spaces, tasks, and updates.",
    future: false,
  },
  {
    key: "execution",
    label: "Task execution",
    description: "Model that will carry out tasks on your behalf.",
    future: true,
  },
];

const SELECTIONS = { chat: "claude-sonnet-5", extraction: "", execution: "" };

type ModelClient = Pick<
  WorkerClient,
  "getHealth" | "getQuota" | "getModels" | "setModel"
>;

const offlineHealth = {
  getHealth: vi.fn(async () => {
    throw new Error("offline");
  }),
  getQuota: vi.fn(async () => {
    throw new Error("offline");
  }),
};

// A window with the shape the worker actually reports: fresh input is a
// rounding error next to the cache, and media spend rides alongside without
// counting toward the limit.
const QUOTA: QuotaInfo = {
  windowMs: 18000000,
  windowStart: 0,
  inputTokens: 1234,
  cacheCreationInputTokens: 10651,
  cacheReadInputTokens: 48000,
  outputTokens: 567,
  billableTokens: 22_887,
  costUsd: 0.1837,
  runCount: 3,
  nearLimit: false,
  media: {
    inputTokens: 17,
    cacheCreationInputTokens: 6000,
    cacheReadInputTokens: 53740,
    outputTokens: 210,
    billableTokens: 13_101,
    costUsd: 0.0342,
    runCount: 9,
  },
};

describe("SettingsTab worker indicator", () => {
  it("shows Online and quota numbers when the worker responds", async () => {
    const client: Pick<WorkerClient, "getHealth" | "getQuota"> = {
      getHealth: vi.fn(async () => ({ ok: true, version: "0.0.1" })),
      getQuota: vi.fn(async () => QUOTA),
    };
    render(<SettingsTab client={client} />);

    await waitFor(() =>
      expect(screen.getByTestId("worker-status").textContent).toBe("Online"),
    );
    expect(screen.getByTestId("quota-input").textContent).toBe("1,234");
    expect(screen.getByTestId("quota-output").textContent).toBe("567");
  });

  it("degrades to Offline with dashes when health throws", async () => {
    const client: Pick<WorkerClient, "getHealth" | "getQuota"> = {
      getHealth: vi.fn(async () => {
        throw new Error("connection refused");
      }),
      getQuota: vi.fn(async () => {
        throw new Error("connection refused");
      }),
    };
    render(<SettingsTab client={client} />);

    await waitFor(() =>
      expect(screen.getByTestId("worker-status").textContent).toBe("Offline"),
    );
    expect(screen.getByTestId("quota-input").textContent).toBe("—");
  });
});

describe("SettingsTab token usage", () => {
  function makeClient(quota: QuotaInfo = QUOTA) {
    return {
      getHealth: vi.fn(async () => ({ ok: true, version: "0.0.1" })),
      getQuota: vi.fn(async () => quota),
    };
  }

  it("shows the six figures a bill is made of, in both blocks", async () => {
    render(<SettingsTab client={makeClient()} />);

    await waitFor(() =>
      expect(screen.getByTestId("quota-input").textContent).toBe("1,234"),
    );
    // The two cache numbers are where a media call's spend actually lives.
    expect(screen.getByTestId("quota-cache-write").textContent).toBe("10,651");
    expect(screen.getByTestId("quota-cache-read").textContent).toBe("48,000");
    expect(screen.getByTestId("quota-output").textContent).toBe("567");
    expect(screen.getByTestId("quota-cost").textContent).toBe("$0.18");
    expect(screen.getByTestId("quota-runs").textContent).toBe("3");

    expect(screen.getByTestId("media-spend-input").textContent).toBe("17");
    expect(screen.getByTestId("media-spend-cache-write").textContent).toBe(
      "6,000",
    );
    expect(screen.getByTestId("media-spend-cache-read").textContent).toBe(
      "53,740",
    );
    expect(screen.getByTestId("media-spend-output").textContent).toBe("210");
    expect(screen.getByTestId("media-spend-cost").textContent).toBe("$0.0342");
    expect(screen.getByTestId("media-spend-runs").textContent).toBe("9");
  });

  it("demotes billable to a secondary line that says what it is", async () => {
    render(<SettingsTab client={makeClient()} />);

    await waitFor(() =>
      expect(screen.getByTestId("quota-billable").textContent).toBe("22,887"),
    );
    expect(screen.getByTestId("quota-billable").parentElement?.textContent).toContain(
      "not a raw count",
    );
    // Media is NOT folded into the chat numbers — they must stay the window's
    // own, since media never counts toward the limit.
    expect(screen.getByTestId("media-spend-billable").textContent).toBe(
      "13,101",
    );
  });

  it("no longer sends the user to Recent runs to find what a window cost", async () => {
    render(<SettingsTab client={makeClient()} />);

    await waitFor(() =>
      expect(screen.getByTestId("quota-cost").textContent).toBe("$0.18"),
    );
    expect(screen.queryByText(/Cost is recorded per call/)).toBeNull();
  });

  it("dashes a window that reported no cost rather than calling it free", async () => {
    const quota: QuotaInfo = {
      ...QUOTA,
      costUsd: null,
      media: { ...QUOTA.media, costUsd: null },
    };
    render(<SettingsTab client={makeClient(quota)} />);

    await waitFor(() =>
      expect(screen.getByTestId("media-spend-cost").textContent).toBe("—"),
    );
    expect(screen.getByTestId("quota-cost").textContent).toBe("—");
    // The tokens are still real — only the price is unknown.
    expect(screen.getByTestId("quota-input").textContent).toBe("1,234");
  });

  it("dashes every figure, cost included, while the worker is offline", async () => {
    const client = {
      getHealth: vi.fn(async () => {
        throw new Error("offline");
      }),
      getQuota: vi.fn(async () => QUOTA),
    };
    render(<SettingsTab client={client} />);

    await waitFor(() =>
      expect(screen.getByTestId("worker-status").textContent).toBe("Offline"),
    );
    for (const id of ["quota-cost", "quota-runs", "media-spend-cost"]) {
      expect(screen.getByTestId(id).textContent).toBe("—");
    }
  });
});

describe("SettingsTab model picker", () => {
  function makeClient(
    setModel = vi.fn(async (role: string, model: string) => ({
      role,
      selected: model,
    })),
  ): ModelClient {
    return {
      ...offlineHealth,
      getModels: vi.fn(async () => ({
        models: CATALOG,
        roles: ROLES,
        selections: SELECTIONS,
      })),
      setModel,
    };
  }

  it("renders one family-grouped select per role with per-role selections", async () => {
    render(<SettingsTab client={makeClient()} />);

    const chat = (await screen.findByTestId(
      "model-select-chat",
    )) as HTMLSelectElement;
    const extraction = screen.getByTestId(
      "model-select-extraction",
    ) as HTMLSelectElement;
    const execution = screen.getByTestId(
      "model-select-execution",
    ) as HTMLSelectElement;

    // Three role selects, one per role.
    expect([chat, extraction, execution]).toHaveLength(3);

    // Chat reflects its selection; extraction defaults to "".
    await waitFor(() => expect(chat.value).toBe("claude-sonnet-5"));
    expect(extraction.value).toBe("");

    // Each select is grouped by family via <optgroup>, in catalog order.
    const optgroups = chat.querySelectorAll("optgroup");
    expect(Array.from(optgroups).map((g) => g.label)).toEqual([
      "Default",
      "Opus",
      "Sonnet",
      "Haiku",
      "Fable",
    ]);
    // All 11 entries rendered as options in each role select.
    expect(chat.querySelectorAll("option")).toHaveLength(11);
    expect(extraction.querySelectorAll("option")).toHaveLength(11);
  });

  it("calls setModel(role, id) when a role's select changes", async () => {
    const setModel = vi.fn(async (role: string, model: string) => ({
      role,
      selected: model,
    }));
    render(<SettingsTab client={makeClient(setModel)} />);

    const extraction = (await screen.findByTestId(
      "model-select-extraction",
    )) as HTMLSelectElement;
    await waitFor(() => expect(extraction.value).toBe(""));

    fireEvent.change(extraction, { target: { value: "claude-opus-4-8" } });

    await waitFor(() =>
      expect(setModel).toHaveBeenCalledWith("extraction", "claude-opus-4-8"),
    );
    // Optimistic + confirmed selection reflects the new id for that role only.
    await waitFor(() => expect(extraction.value).toBe("claude-opus-4-8"));
  });

  it("shows the future hint for the task execution role", async () => {
    render(<SettingsTab client={makeClient()} />);

    // The picker is enabled/persistable, but carries the future hint.
    await screen.findByTestId("model-select-execution");
    expect(
      screen.getByText("Takes effect when task execution ships."),
    ).toBeTruthy();
  });

  // The models card is data-driven over `res.roles`, so it must render whatever
  // the worker returns. V8's worker serves exactly one role (chat); this
  // seven-role fixture exists to prove the card isn't hardcoded to that.
  it("renders a select for all seven roles the worker returns", async () => {
    const SEVEN_ROLES: RoleInfo[] = [
      { key: "chat", label: "Chat", description: "Interactive chat", future: false },
      { key: "extraction", label: "Extraction", description: "Brain extraction", future: false },
      { key: "triage", label: "Triage", description: "Classifies proposed tasks", future: false },
      { key: "done_detection", label: "Done detection", description: "Detects completed tasks", future: false },
      { key: "planning", label: "Planning", description: "Writes the plan", future: false },
      { key: "execution", label: "Task execution", description: "Runs tasks with tools", future: false },
      { key: "extra", label: "Extra role", description: "Proves the picker is data-driven, not hardcoded", future: false },
    ];
    const client: ModelClient = {
      ...offlineHealth,
      getModels: vi.fn(async () => ({
        models: CATALOG,
        roles: SEVEN_ROLES,
        selections: {},
      })),
      setModel: vi.fn(async (role: string, model: string) => ({
        role,
        selected: model,
      })),
    };
    render(<SettingsTab client={client} />);

    // Every role from the worker gets its own data-testid select.
    for (const role of SEVEN_ROLES) {
      expect(
        await screen.findByTestId(`model-select-${role.key}`),
      ).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// Runs viewer + Logs card.
// ---------------------------------------------------------------------------

type ExtrasClient = Pick<WorkerClient, "getHealth" | "getQuota"> &
  Partial<
    Pick<
      WorkerClient,
      "listRuns" | "getLogsInfo" | "revealLogs"
    >
  >;

const RUNS: RunListItem[] = [
  {
    id: "1",
    process: "chat",
    model: "claude-sonnet-5",
    input_tokens: 1200,
    cache_creation_input_tokens: 8000,
    cache_read_input_tokens: 12000,
    output_tokens: 340,
    cost_usd: 0.0421,
    duration_ms: 2500,
    status: "ok",
    created_at: "2026-07-10T10:00:00Z",
  },
  {
    // Killed before the CLI reported a cost: real tokens, no cost figure.
    id: "2",
    process: "execution",
    model: "claude-opus-4-8",
    input_tokens: 5000,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 900,
    cost_usd: null,
    duration_ms: 65000,
    status: "error",
    created_at: "2026-07-10T09:00:00Z",
  },
];

const LOGS: LogsInfo = {
  dir: "/Users/x/SuperTwinV11/logs",
  files: [
    { name: "worker-node.log", size: 2048, modified: "2026-07-10T10:00:00Z" },
  ],
};

describe("SettingsTab runs viewer", () => {
  it("renders a row per run from listRuns", async () => {
    const listRuns = vi.fn(async () => RUNS);
    const client: ExtrasClient = { ...offlineHealth, listRuns };
    render(<SettingsTab client={client} />);

    const table = await screen.findByTestId("runs-table");
    // The two mocked runs render as body rows.
    const rows = within(table).getAllByRole("row");
    // 1 header row + 2 data rows.
    expect(rows).toHaveLength(3);
    expect(within(table).getByText("chat")).toBeTruthy();
    expect(within(table).getByText("execution")).toBeTruthy();
    expect(within(table).getByText("claude-sonnet-5")).toBeTruthy();
    expect(listRuns).toHaveBeenCalled();
  });

  it("shows each run's cost, and dashes the one that never reported it", async () => {
    const client: ExtrasClient = {
      ...offlineHealth,
      listRuns: vi.fn(async () => RUNS),
    };
    render(<SettingsTab client={client} />);

    const table = await screen.findByTestId("runs-table");
    expect(within(table).getByText("$0.0421")).toBeTruthy();
    // A killed run has tokens but no cost figure — "$0.00" would be a lie.
    expect(within(table).queryByText("$0.00")).toBeNull();
    // The cache the call paid for sits beside fresh input (8,000 + 12,000).
    expect(within(table).getByText("20,000")).toBeTruthy();
  });

  it("U-003: carries the total input beside the parts, never the parts alone", async () => {
    const client: ExtrasClient = {
      ...offlineHealth,
      listRuns: vi.fn(async () => RUNS),
    };
    render(<SettingsTab client={client} />);

    await screen.findByTestId("runs-table");
    // 1,200 fresh + 8,000 written + 12,000 read is ONE 21,200-token input.
    expect(screen.getByTestId("run-total-input-1").textContent).toBe("21,200");
    // A call that genuinely cached nothing still states its total.
    expect(screen.getByTestId("run-total-input-2").textContent).toBe("5,000");
  });

  it("re-fetches when Refresh is clicked", async () => {
    const listRuns = vi.fn(async () => RUNS);
    const client: ExtrasClient = { ...offlineHealth, listRuns };
    render(<SettingsTab client={client} />);

    await screen.findByTestId("runs-table");
    const callsBefore = listRuns.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() =>
      expect(listRuns.mock.calls.length).toBeGreaterThan(callsBefore),
    );
  });

  it("says a short page is the whole log, and offers no way further back", async () => {
    const client: ExtrasClient = {
      ...offlineHealth,
      listRuns: vi.fn(async () => RUNS),
    };
    render(<SettingsTab client={client} />);

    expect((await screen.findByTestId("runs-count")).textContent).toContain(
      "2 runs shown — that is all of them",
    );
    expect(screen.queryByTestId("runs-load-more")).toBeNull();
  });

  it("pages back through the whole table, a page at a time", async () => {
    // A full page means older runs may exist; the pages are asked for by offset
    // and appended, so the table grows instead of jumping.
    const page = (n: number, offset: number): RunListItem[] =>
      Array.from({ length: n }, (_, i) => ({
        ...RUNS[0],
        id: `r${offset + i}`,
        model: `m${offset + i}`,
      }));
    const listRuns = vi.fn(
      async (opts: { limit?: number; offset?: number } = {}) => {
        const offset = opts.offset ?? 0;
        return offset === 0 ? page(50, 0) : page(20, offset);
      },
    );
    const client: ExtrasClient = { ...offlineHealth, listRuns };
    render(<SettingsTab client={client} />);

    const table = await screen.findByTestId("runs-table");
    expect(within(table).getAllByRole("row")).toHaveLength(51);

    fireEvent.click(await screen.findByTestId("runs-load-more"));
    await waitFor(() =>
      expect(within(table).getAllByRole("row")).toHaveLength(71),
    );
    expect(listRuns).toHaveBeenCalledWith({ limit: 50, offset: 50 });
    // The second page was short, so there is nothing older to ask for.
    await waitFor(() =>
      expect(screen.queryByTestId("runs-load-more")).toBeNull(),
    );
    expect(screen.getByTestId("runs-count").textContent).toContain("70 runs");
  });

  it("shows a row once when a run landing mid-read shifts the offsets", async () => {
    // A run recorded between the two reads pushes everything down one, so the
    // next page starts with a row that is already on screen.
    const first = Array.from({ length: 50 }, (_, i) => ({
      ...RUNS[0],
      id: `r${i}`,
      model: `m${i}`,
    }));
    const listRuns = vi.fn(
      async (opts: { limit?: number; offset?: number } = {}) =>
        (opts.offset ?? 0) === 0
          ? first
          : [first[49], { ...RUNS[0], id: "older", model: "older" }],
    );
    const client: ExtrasClient = { ...offlineHealth, listRuns };
    render(<SettingsTab client={client} />);

    const table = await screen.findByTestId("runs-table");
    fireEvent.click(await screen.findByTestId("runs-load-more"));
    await waitFor(() =>
      expect(within(table).getByText("older")).toBeTruthy(),
    );
    expect(within(table).getAllByRole("row")).toHaveLength(52);
    expect(within(table).getAllByText("m49")).toHaveLength(1);
  });

  it("keeps polling when the older page never arrived", async () => {
    // The poll stands down while the reader is further back in the log. A page
    // that failed left them on the newest one, so it has nothing to disturb.
    vi.useFakeTimers();
    try {
      const first = Array.from({ length: 50 }, (_, i) => ({
        ...RUNS[0],
        id: `r${i}`,
        model: `m${i}`,
      }));
      const listRuns = vi.fn(
        async (opts: { limit?: number; offset?: number } = {}) => {
          if ((opts.offset ?? 0) > 0) throw new Error("worker went away");
          return first;
        },
      );
      const client: ExtrasClient = { ...offlineHealth, listRuns };
      render(<SettingsTab client={client} />);

      await vi.waitFor(() =>
        expect(screen.getByTestId("runs-load-more")).toBeTruthy(),
      );
      fireEvent.click(screen.getByTestId("runs-load-more"));
      await vi.waitFor(() =>
        expect(listRuns).toHaveBeenCalledWith({ limit: 50, offset: 50 }),
      );

      const callsBefore = listRuns.mock.calls.length;
      // Past the 8s runs poll.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8500);
      });
      expect(listRuns.mock.calls.length).toBeGreaterThan(callsBefore);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SettingsTab logs card", () => {
  it("shows the logs dir and calls revealLogs when Open is clicked", async () => {
    const revealLogs = vi.fn(async () => ({ ok: true }));
    const client: ExtrasClient = {
      ...offlineHealth,
      getLogsInfo: vi.fn(async () => LOGS),
      revealLogs,
    };
    render(<SettingsTab client={client} />);

    // Dir + file listing render.
    await waitFor(() =>
      expect(screen.getByText("/Users/x/SuperTwinV11/logs")).toBeTruthy(),
    );
    expect(screen.getByText("worker-node.log")).toBeTruthy();

    fireEvent.click(screen.getByTestId("open-logs"));
    await waitFor(() => expect(revealLogs).toHaveBeenCalled());
  });
});

// ---------------------------------------------------------------------------
// Feature A: brain wiki folder card.
// ---------------------------------------------------------------------------

describe("SettingsTab brain card", () => {
  it("shows the brain dir and calls revealBrain when Open is clicked", async () => {
    const revealBrain = vi.fn(async () => ({ ok: true }));
    const client: Pick<WorkerClient, "getHealth" | "getQuota"> &
      Partial<Pick<WorkerClient, "getBrainInfo" | "revealBrain">> = {
      ...offlineHealth,
      getBrainInfo: vi.fn(async () => ({
        dir: "/Users/x/SuperTwinV11/brain",
        fileCount: 42,
      })),
      revealBrain,
    };
    render(<SettingsTab client={client} />);

    // The brain dir path renders.
    await waitFor(() =>
      expect(screen.getByText("/Users/x/SuperTwinV11/brain")).toBeTruthy(),
    );

    fireEvent.click(screen.getByTestId("open-brain"));
    await waitFor(() => expect(revealBrain).toHaveBeenCalled());
  });
});

// ---------------------------------------------------------------------------
// Feature B: per-process on/off toggles in the Models card.
// ---------------------------------------------------------------------------

describe("SettingsTab process toggles", () => {
  // The picker is data-driven: it renders whatever role list the worker sends.
  // V8's worker sends exactly one (chat); this multi-role fixture stays because
  // its whole job is to prove the renderer is not hardcoded to a fixed list.
  const SEVEN_ROLES: RoleInfo[] = [
    { key: "chat", label: "Chat", description: "Interactive chat", future: false },
    { key: "extraction", label: "Extraction", description: "Brain extraction", future: false },
    { key: "triage", label: "Triage", description: "Classifies proposed tasks", future: false },
    { key: "done_detection", label: "Done detection", description: "Detects completed tasks", future: false },
    { key: "planning", label: "Planning", description: "Writes the plan", future: false },
    { key: "execution", label: "Task execution", description: "Runs tasks with tools", future: false },
    { key: "nightly", label: "Nightly self-update", description: "Summarizes the nightly self-update", future: false },
  ];

  type ToggleClient = Pick<WorkerClient, "getHealth" | "getQuota"> &
    Partial<Pick<WorkerClient, "getModels" | "setModel" | "setProcessEnabled">>;

  function makeClient(
    enabledByRole: Record<string, boolean>,
    setProcessEnabled = vi.fn(async (role: string, enabled: boolean) => ({
      role,
      enabled,
    })),
  ): ToggleClient {
    return {
      ...offlineHealth,
      getModels: vi.fn(async () => ({
        models: CATALOG,
        roles: SEVEN_ROLES,
        selections: {},
        enabledByRole,
      })),
      setModel: vi.fn(async (role: string, model: string) => ({
        role,
        selected: model,
      })),
      setProcessEnabled,
    };
  }

  it("renders an on/off toggle per role reflecting enabledByRole", async () => {
    const enabledByRole = {
      chat: true,
      extraction: true,
      triage: false,
      done_detection: true,
      planning: true,
      execution: true,
    };
    render(<SettingsTab client={makeClient(enabledByRole)} />);

    // Every role gets its own toggle.
    for (const role of SEVEN_ROLES) {
      expect(
        await screen.findByTestId(`process-toggle-${role.key}`),
      ).toBeTruthy();
    }
    // The flag is reflected: triage off, chat on.
    const triageToggle = screen.getByTestId(
      "process-toggle-triage",
    ) as HTMLInputElement;
    const chatToggle = screen.getByTestId(
      "process-toggle-chat",
    ) as HTMLInputElement;
    await waitFor(() => expect(triageToggle.checked).toBe(false));
    expect(chatToggle.checked).toBe(true);
  });

  it("calls setProcessEnabled(role, next) when a toggle changes", async () => {
    const setProcessEnabled = vi.fn(async (role: string, enabled: boolean) => ({
      role,
      enabled,
    }));
    const enabledByRole = {
      chat: true,
      extraction: true,
      triage: true,
      done_detection: true,
      planning: true,
      execution: true,
    };
    render(
      <SettingsTab client={makeClient(enabledByRole, setProcessEnabled)} />,
    );

    const chatToggle = (await screen.findByTestId(
      "process-toggle-chat",
    )) as HTMLInputElement;
    await waitFor(() => expect(chatToggle.checked).toBe(true));

    // Turning it off persists `false` for that role only.
    fireEvent.click(chatToggle);
    await waitFor(() =>
      expect(setProcessEnabled).toHaveBeenCalledWith("chat", false),
    );
    await waitFor(() => expect(chatToggle.checked).toBe(false));
  });

  it("warns on the chat role that its toggle is the app's only feature", async () => {
    render(<SettingsTab client={makeClient({ chat: true })} />);

    const warning = await screen.findByTestId("chat-role-warning");
    expect(warning.textContent).toContain("only thing SuperTwinV11 does");
    // Exactly one role carries the warning — the other six must not.
    expect(screen.getAllByTestId("chat-role-warning")).toHaveLength(1);
  });

  it("greys and disables the model select for a disabled role", async () => {
    const enabledByRole = {
      chat: true,
      extraction: true,
      triage: false,
      done_detection: true,
      planning: true,
      execution: true,
    };
    render(<SettingsTab client={makeClient(enabledByRole)} />);

    const triageSelect = (await screen.findByTestId(
      "model-select-triage",
    )) as HTMLSelectElement;
    // The off role's select is disabled…
    await waitFor(() => expect(triageSelect.disabled).toBe(true));
    // …while an on role's select stays enabled.
    const chatSelect = screen.getByTestId(
      "model-select-chat",
    ) as HTMLSelectElement;
    expect(chatSelect.disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Media reader: the six switches, rate limit, backlog counters and re-scan.
// ---------------------------------------------------------------------------

describe("SettingsTab media section", () => {
  type MediaClient = Pick<WorkerClient, "getHealth" | "getQuota"> &
    Partial<
      Pick<
        WorkerClient,
        | "getMediaSettings"
        | "setMediaSettings"
        | "getMediaQueue"
        | "rescanMedia"
      >
    >;

  const MEDIA: MediaSettings = {
    describe_enabled: true,
    backfill_enabled: false,
    images_enabled: true,
    video_enabled: false,
    business_enabled: false,
    link_scrape_enabled: false,
    video_frames_enabled: false,
    video_audio_enabled: false,
    voice_notes_enabled: false,
    rate_per_min: 12,
    concurrency: 5,
    image_batch: 20,
    video_frame_interval_sec: 5,
    video_frame_max: 8,
    video_max_height: 480,
    whisper_model: "large-v3-turbo-q5_0",
  };

  const QUEUE: MediaQueue = { pending: 7, done: 120, unsupported: 3, error: 1 };

  function makeClient(
    setMediaSettings = vi.fn(async (patch: Partial<MediaSettings>) => ({
      ...MEDIA,
      ...patch,
    })),
  ): MediaClient {
    return {
      ...offlineHealth,
      getMediaSettings: vi.fn(async () => MEDIA),
      setMediaSettings,
      getMediaQueue: vi.fn(async () => QUEUE),
    };
  }

  it("reflects the stored settings and the backfill queue", async () => {
    render(<SettingsTab client={makeClient()} />);

    const describe = (await screen.findByTestId(
      "media-describe",
    )) as HTMLInputElement;
    const backfill = screen.getByTestId("media-backfill") as HTMLInputElement;
    const rate = screen.getByTestId("media-rate") as HTMLInputElement;

    await waitFor(() => expect(describe.checked).toBe(true));
    expect(backfill.checked).toBe(false);
    expect(rate.value).toBe("12");

    await waitFor(() =>
      expect(screen.getByTestId("media-pending").textContent).toBe("7"),
    );
    expect(screen.getByTestId("media-done").textContent).toBe("120");
    expect(screen.getByTestId("media-unsupported").textContent).toBe("3");
    expect(screen.getByTestId("media-error").textContent).toBe("1");
  });

  it("reflects each per-type switch, including the three that default off", async () => {
    render(<SettingsTab client={makeClient()} />);

    const images = (await screen.findByTestId("media-images")) as HTMLInputElement;
    await waitFor(() => expect(images.checked).toBe(true));
    for (const id of ["media-video", "media-business", "media-link-scrape"]) {
      expect((screen.getByTestId(id) as HTMLInputElement).checked).toBe(false);
    }
  });

  it("says out loud that fetching a link is an outbound request the sender can see", async () => {
    render(<SettingsTab client={makeClient()} />);

    await screen.findByTestId("media-link-scrape");
    const copy = screen.getByText(/outbound request to a URL somebody else chose/);
    expect(copy.textContent).toContain("can see it was opened");
  });

  it("persists each per-type switch as its own single-key patch", async () => {
    const setMediaSettings = vi.fn(async (patch: Partial<MediaSettings>) => ({
      ...MEDIA,
      ...patch,
    }));
    render(<SettingsTab client={makeClient(setMediaSettings)} />);

    const cases: [string, keyof MediaSettings][] = [
      ["media-images", "images_enabled"],
      ["media-video", "video_enabled"],
      ["media-business", "business_enabled"],
      ["media-link-scrape", "link_scrape_enabled"],
    ];
    for (const [testId, key] of cases) {
      const el = (await screen.findByTestId(testId)) as HTMLInputElement;
      const next = !el.checked;
      fireEvent.click(el);
      await waitFor(() =>
        expect(setMediaSettings).toHaveBeenCalledWith({ [key]: next }),
      );
    }
  });

  it("persists a switch as a single-key patch", async () => {
    const setMediaSettings = vi.fn(async (patch: Partial<MediaSettings>) => ({
      ...MEDIA,
      ...patch,
    }));
    render(<SettingsTab client={makeClient(setMediaSettings)} />);

    const backfill = (await screen.findByTestId(
      "media-backfill",
    )) as HTMLInputElement;
    await waitFor(() => expect(backfill.checked).toBe(false));

    fireEvent.click(backfill);
    await waitFor(() =>
      expect(setMediaSettings).toHaveBeenCalledWith({ backfill_enabled: true }),
    );
    await waitFor(() => expect(backfill.checked).toBe(true));
  });

  it("commits the rate on blur and snaps back on a nonsense entry", async () => {
    const setMediaSettings = vi.fn(async (patch: Partial<MediaSettings>) => ({
      ...MEDIA,
      ...patch,
    }));
    render(<SettingsTab client={makeClient(setMediaSettings)} />);

    const rate = (await screen.findByTestId("media-rate")) as HTMLInputElement;
    await waitFor(() => expect(rate.value).toBe("12"));

    fireEvent.change(rate, { target: { value: "30" } });
    fireEvent.blur(rate);
    await waitFor(() =>
      expect(setMediaSettings).toHaveBeenCalledWith({ rate_per_min: 30 }),
    );
    await waitFor(() => expect(rate.value).toBe("30"));

    fireEvent.change(rate, { target: { value: "-5" } });
    fireEvent.blur(rate);
    await waitFor(() => expect(rate.value).toBe("30"));
    expect(setMediaSettings).toHaveBeenCalledTimes(1);

    // Parses to what is already stored: nothing to persist, but the field must
    // still show the stored number rather than what was typed.
    fireEvent.change(rate, { target: { value: "030" } });
    fireEvent.blur(rate);
    await waitFor(() => expect(rate.value).toBe("30"));
    expect(setMediaSettings).toHaveBeenCalledTimes(1);
  });

  it("commits the photos-per-call size and adopts what the worker stored", async () => {
    // The worker clamps to its own ceiling; the box must end up showing what it
    // kept, not the number that was typed at it.
    const setMediaSettings = vi.fn(async (patch: Partial<MediaSettings>) => ({
      ...MEDIA,
      ...patch,
      image_batch: Math.min(patch.image_batch ?? MEDIA.image_batch, 40),
    }));
    render(<SettingsTab client={makeClient(setMediaSettings)} />);

    const batch = (await screen.findByTestId(
      "media-image-batch",
    )) as HTMLInputElement;
    await waitFor(() => expect(batch.value).toBe("20"));

    fireEvent.change(batch, { target: { value: "8" } });
    fireEvent.blur(batch);
    await waitFor(() =>
      expect(setMediaSettings).toHaveBeenCalledWith({ image_batch: 8 }),
    );
    await waitFor(() => expect(batch.value).toBe("8"));

    fireEvent.change(batch, { target: { value: "999" } });
    fireEvent.blur(batch);
    await waitFor(() => expect(batch.value).toBe("40"));

    // A batch of nothing is not a batch — it never leaves the UI.
    fireEvent.change(batch, { target: { value: "0" } });
    fireEvent.blur(batch);
    await waitFor(() => expect(batch.value).toBe("40"));
    expect(setMediaSettings).toHaveBeenCalledTimes(2);
  });

  it("commits how many media reads run at once, and adopts the worker's cap", async () => {
    const setMediaSettings = vi.fn(async (patch: Partial<MediaSettings>) => ({
      ...MEDIA,
      ...patch,
      concurrency: Math.min(patch.concurrency ?? MEDIA.concurrency, 20),
    }));
    render(<SettingsTab client={makeClient(setMediaSettings)} />);

    const slots = (await screen.findByTestId(
      "media-concurrency",
    )) as HTMLInputElement;
    await waitFor(() => expect(slots.value).toBe("5"));

    fireEvent.change(slots, { target: { value: "8" } });
    fireEvent.blur(slots);
    await waitFor(() =>
      expect(setMediaSettings).toHaveBeenCalledWith({ concurrency: 8 }),
    );
    await waitFor(() => expect(slots.value).toBe("8"));

    // The worker clamps; a number it reduced must not sit there looking taken.
    fireEvent.change(slots, { target: { value: "900" } });
    fireEvent.blur(slots);
    await waitFor(() => expect(slots.value).toBe("20"));

    // Reading nothing at a time is not a setting — it never leaves the UI.
    fireEvent.change(slots, { target: { value: "0" } });
    fireEvent.blur(slots);
    await waitFor(() => expect(slots.value).toBe("20"));
    expect(setMediaSettings).toHaveBeenCalledTimes(2);
  });

  it("keeps the two numbers apart — committing one does not resend the other", async () => {
    const setMediaSettings = vi.fn(async (patch: Partial<MediaSettings>) => ({
      ...MEDIA,
      ...patch,
    }));
    render(<SettingsTab client={makeClient(setMediaSettings)} />);

    const batch = (await screen.findByTestId(
      "media-image-batch",
    )) as HTMLInputElement;
    await waitFor(() => expect(batch.value).toBe("20"));
    fireEvent.change(batch, { target: { value: "12" } });
    fireEvent.blur(batch);

    await waitFor(() =>
      expect(setMediaSettings).toHaveBeenCalledWith({ image_batch: 12 }),
    );
    expect((screen.getByTestId("media-rate") as HTMLInputElement).value).toBe(
      "12",
    );
  });

  it("disables the controls when the worker cannot answer", async () => {
    const client: MediaClient = {
      ...offlineHealth,
      getMediaSettings: vi.fn(async () => {
        throw new Error("offline");
      }),
      getMediaQueue: vi.fn(async () => {
        throw new Error("offline");
      }),
    };
    render(<SettingsTab client={client} />);

    const describe = (await screen.findByTestId(
      "media-describe",
    )) as HTMLInputElement;
    await waitFor(() => expect(describe.disabled).toBe(true));
    expect((screen.getByTestId("media-rate") as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByTestId("media-image-batch") as HTMLInputElement).disabled,
    ).toBe(true);
    expect(screen.getByTestId("media-pending").textContent).toBe("—");
  });

  // -------------------------------------------------------------------------
  // v5 §2: frame sampling and its two numbers.
  // -------------------------------------------------------------------------

  it("ships frame sampling off and persists it as its own patch", async () => {
    const setMediaSettings = vi.fn(async (patch: Partial<MediaSettings>) => ({
      ...MEDIA,
      ...patch,
    }));
    render(<SettingsTab client={makeClient(setMediaSettings)} />);

    const frames = (await screen.findByTestId(
      "media-video-frames",
    )) as HTMLInputElement;
    await waitFor(() => expect(frames.checked).toBe(false));

    fireEvent.click(frames);
    await waitFor(() =>
      expect(setMediaSettings).toHaveBeenCalledWith({
        video_frames_enabled: true,
      }),
    );
  });

  it("does not claim the video is watched — it says stills", async () => {
    render(<SettingsTab client={makeClient()} />);

    await screen.findByTestId("media-video-frames");
    const copy = screen.getByText(/It is still stills/);
    expect(copy.textContent).toContain("nothing plays the video");
  });

  it("locks the frame numbers until frame sampling is on", async () => {
    const setMediaSettings = vi.fn(async (patch: Partial<MediaSettings>) => ({
      ...MEDIA,
      ...patch,
    }));
    render(<SettingsTab client={makeClient(setMediaSettings)} />);

    const interval = (await screen.findByTestId(
      "media-frame-interval",
    )) as HTMLInputElement;
    const max = screen.getByTestId("media-frame-max") as HTMLInputElement;
    await waitFor(() => expect(interval.value).toBe("5"));
    expect(max.value).toBe("8");
    expect(interval.disabled).toBe(true);
    expect(max.disabled).toBe(true);

    fireEvent.click(screen.getByTestId("media-video-frames"));
    await waitFor(() => expect(interval.disabled).toBe(false));
  });

  it("says so when frame sampling is on but videos are not read at all", async () => {
    // Stateful, because what is being tested is the combination of two
    // switches — a mock that forgets the first one proves nothing.
    let stored = { ...MEDIA };
    const setMediaSettings = vi.fn(async (patch: Partial<MediaSettings>) => {
      stored = { ...stored, ...patch };
      return stored;
    });
    render(<SettingsTab client={makeClient(setMediaSettings)} />);

    fireEvent.click(await screen.findByTestId("media-video-frames"));
    const inert = await screen.findByTestId("media-video-frames-inert");
    expect(inert.textContent).toContain("nothing is sampled");

    // Turning Videos on is what makes it do something, and the note goes.
    fireEvent.click(screen.getByTestId("media-video"));
    await waitFor(() =>
      expect(screen.queryByTestId("media-video-frames-inert")).toBeNull(),
    );
  });

  it("commits each frame number on its own and adopts the clamped answer", async () => {
    const setMediaSettings = vi.fn(async (patch: Partial<MediaSettings>) => ({
      ...MEDIA,
      video_frames_enabled: true,
      ...patch,
      ...(patch.video_frame_max !== undefined
        ? { video_frame_max: Math.min(patch.video_frame_max, 20) }
        : {}),
    }));
    render(<SettingsTab client={makeClient(setMediaSettings)} />);

    fireEvent.click(await screen.findByTestId("media-video-frames"));
    const interval = screen.getByTestId(
      "media-frame-interval",
    ) as HTMLInputElement;
    const max = screen.getByTestId("media-frame-max") as HTMLInputElement;
    await waitFor(() => expect(interval.disabled).toBe(false));

    fireEvent.change(interval, { target: { value: "10" } });
    fireEvent.blur(interval);
    await waitFor(() =>
      expect(setMediaSettings).toHaveBeenCalledWith({
        video_frame_interval_sec: 10,
      }),
    );
    // The cap is untouched by an interval commit.
    expect(max.value).toBe("8");

    fireEvent.change(max, { target: { value: "999" } });
    fireEvent.blur(max);
    await waitFor(() => expect(max.value).toBe("20"));
  });

  // -------------------------------------------------------------------------
  // v7 §4: a linked YouTube/Instagram clip is downloaded, sampled and
  // transcribed. It reuses the two frame numbers above rather than inventing a
  // second set; the height is the one thing only a download gets to choose.
  // -------------------------------------------------------------------------

  it("only offers the linked-video height once links are being fetched", async () => {
    const setMediaSettings = vi.fn(async (patch: Partial<MediaSettings>) => ({
      ...MEDIA,
      ...patch,
    }));
    render(<SettingsTab client={makeClient(setMediaSettings)} />);

    const height = (await screen.findByTestId(
      "media-video-max-height",
    )) as HTMLInputElement;
    await waitFor(() => expect(height.value).toBe("480"));
    // Nothing is downloaded while link fetching is off, so nothing to size.
    expect(height.disabled).toBe(true);

    fireEvent.click(screen.getByTestId("media-link-scrape"));
    await waitFor(() => expect(height.disabled).toBe(false));

    fireEvent.change(height, { target: { value: "720" } });
    fireEvent.blur(height);
    await waitFor(() =>
      expect(setMediaSettings).toHaveBeenCalledWith({ video_max_height: 720 }),
    );
  });

  it("refuses a height under the floor rather than sending one the worker would raise", async () => {
    const setMediaSettings = vi.fn(async (patch: Partial<MediaSettings>) => ({
      ...MEDIA,
      link_scrape_enabled: true,
      ...patch,
    }));
    render(<SettingsTab client={makeClient(setMediaSettings)} />);

    fireEvent.click(await screen.findByTestId("media-link-scrape"));
    const height = screen.getByTestId(
      "media-video-max-height",
    ) as HTMLInputElement;
    await waitFor(() => expect(height.disabled).toBe(false));
    setMediaSettings.mockClear();

    fireEvent.change(height, { target: { value: "72" } });
    fireEvent.blur(height);
    // Under 144 no site publishes a matching format and the download falls
    // back to "worst" — so the box snaps back instead of storing it.
    await waitFor(() => expect(height.value).toBe("480"));
    expect(setMediaSettings).not.toHaveBeenCalled();
  });

  it("says out loud that a link switch now fetches the clip itself", async () => {
    render(<SettingsTab client={makeClient()} />);
    const row = (await screen.findByTestId("media-link-scrape")).closest(
      ".settings__media-switch",
    ) as HTMLElement;
    // The switch reaches further than it used to: a reader deciding whether to
    // turn it on has to be told that before they do, not after.
    expect(row.textContent).toMatch(/YouTube or Instagram/);
    expect(row.textContent).toMatch(/deleted/);
  });

  // -------------------------------------------------------------------------
  // Re-scan: the only control here that starts model calls.
  // -------------------------------------------------------------------------

  it("re-queues the chosen types and reports what moved", async () => {
    const rescanMedia = vi.fn(async () => ({
      media: 128,
      links: 4,
      transcripts: 0,
      frames: 0,
    }));
    const client: MediaClient = { ...makeClient(), rescanMedia };
    render(<SettingsTab client={client} />);

    fireEvent.click(await screen.findByTestId("rescan-image"));
    fireEvent.click(screen.getByTestId("rescan-link"));
    fireEvent.click(screen.getByTestId("rescan-run"));
    // The run goes through a confirm — the click itself must not start it.
    expect(rescanMedia).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("rescan-confirm"));
    await waitFor(() =>
      expect(rescanMedia).toHaveBeenCalledWith(["image", "link"]),
    );
    await waitFor(() =>
      expect(screen.getByTestId("rescan-result").textContent).toContain(
        "128 media, 4 links",
      ),
    );
  });

  it("offers the two v5 re-scan types and counts them apart", async () => {
    const rescanMedia = vi.fn(async () => ({
      media: 0,
      links: 0,
      transcripts: 31,
      frames: 9,
    }));
    const client: MediaClient = { ...makeClient(), rescanMedia };
    render(<SettingsTab client={client} />);

    fireEvent.click(await screen.findByTestId("rescan-frames"));
    fireEvent.click(screen.getByTestId("rescan-transcript"));
    fireEvent.click(screen.getByTestId("rescan-run"));
    fireEvent.click(screen.getByTestId("rescan-confirm"));

    await waitFor(() =>
      expect(rescanMedia).toHaveBeenCalledWith(["frames", "transcript"]),
    );
    await waitFor(() =>
      expect(screen.getByTestId("rescan-result").textContent).toContain(
        "31 recordings and 9 videos' frames",
      ),
    );
  });

  it("does not claim a transcript re-scan costs tokens, or touches links", async () => {
    render(<SettingsTab client={makeClient()} />);

    fireEvent.click(await screen.findByTestId("rescan-transcript"));
    fireEvent.click(screen.getByTestId("rescan-run"));

    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(/spends no tokens/)).toBeTruthy();
    expect(dialog.queryByText(/sent to Claude again/)).toBeNull();
    // Nothing was fetched from the network — no link was chosen.
    expect(dialog.queryByText(/outbound request/)).toBeNull();
  });

  it("names every price a mixed re-scan pays, one paragraph each", async () => {
    render(<SettingsTab client={makeClient()} />);

    fireEvent.click(await screen.findByTestId("rescan-image"));
    fireEvent.click(screen.getByTestId("rescan-link"));
    fireEvent.click(screen.getByTestId("rescan-transcript"));
    fireEvent.click(screen.getByTestId("rescan-run"));

    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(/sent to Claude again/)).toBeTruthy();
    expect(dialog.getByText(/outbound request/)).toBeTruthy();
    expect(dialog.getByText(/spends no tokens/)).toBeTruthy();
  });

  it("cannot be run with nothing chosen, and never fires from a switch", async () => {
    const rescanMedia = vi.fn(async () => ({
      media: 0,
      links: 0,
      transcripts: 0,
      frames: 0,
    }));
    const setMediaSettings = vi.fn(async (patch: Partial<MediaSettings>) => ({
      ...MEDIA,
      ...patch,
    }));
    const client: MediaClient = {
      ...makeClient(setMediaSettings),
      rescanMedia,
    };
    render(<SettingsTab client={client} />);

    const run = (await screen.findByTestId("rescan-run")) as HTMLButtonElement;
    expect(run.disabled).toBe(true);

    // Turning a switch ON must not re-read anything: that is the whole reason
    // re-scanning is a separate button.
    fireEvent.click(screen.getByTestId("media-video"));
    await waitFor(() =>
      expect(setMediaSettings).toHaveBeenCalledWith({ video_enabled: true }),
    );
    expect(rescanMedia).not.toHaveBeenCalled();
  });

  it("surfaces a failed re-scan instead of looking like it started", async () => {
    const rescanMedia = vi.fn(async () => {
      throw new Error("worker offline");
    });
    const client: MediaClient = { ...makeClient(), rescanMedia };
    render(<SettingsTab client={client} />);

    fireEvent.click(await screen.findByTestId("rescan-document"));
    fireEvent.click(screen.getByTestId("rescan-run"));
    fireEvent.click(screen.getByTestId("rescan-confirm"));

    await waitFor(() =>
      expect(screen.getByTestId("rescan-error").textContent).toBe(
        "worker offline",
      ),
    );
    expect(screen.queryByTestId("rescan-result")).toBeNull();
  });
});

describe("SettingsTab transcription section", () => {
  type ToolClient = Pick<WorkerClient, "getHealth" | "getQuota"> &
    Partial<
      Pick<
        WorkerClient,
        | "getMediaSettings"
        | "setMediaSettings"
        | "getMediaQueue"
        | "getMediaTools"
        | "downloadWhisperModel"
        | "cancelWhisperModel"
        | "deleteWhisperModel"
      >
    >;

  const MEDIA: MediaSettings = {
    describe_enabled: true,
    backfill_enabled: true,
    images_enabled: true,
    video_enabled: false,
    business_enabled: false,
    link_scrape_enabled: false,
    video_frames_enabled: false,
    video_audio_enabled: false,
    voice_notes_enabled: false,
    rate_per_min: 20,
    concurrency: 5,
    image_batch: 20,
    video_frame_interval_sec: 5,
    video_frame_max: 8,
    video_max_height: 480,
    whisper_model: "large-v3-turbo-q5_0",
  };

  function model(
    id: string,
    over: Partial<WhisperModelState> = {},
  ): WhisperModelState {
    return {
      id,
      label: id,
      bytes: 574_041_195,
      bundled: false,
      present: false,
      bytesOnDisk: null,
      selected: false,
      download: null,
      ...over,
    };
  }

  const TOOLS: MediaToolState = {
    ffmpeg: { path: "/app/bin/ffmpeg", present: true, version: "8.1" },
    whisper: { path: "/app/bin/whisper-cli", present: true, version: "1.9.1" },
    ytdlp: { path: "/app/bin/yt-dlp", present: true, version: "2026.03.31" },
    models: [
      model("tiny", { bytes: 77_691_713 }),
      model("large-v3-turbo-q5_0", {
        bundled: true,
        present: true,
        bytesOnDisk: 574_041_195,
        selected: true,
      }),
      model("large-v3", { bytes: 3_095_033_483 }),
    ],
    modelsDir: "/Users/x/SuperTwinV11/models",
  };

  function makeClient(over: Partial<ToolClient> = {}): ToolClient {
    return {
      ...offlineHealth,
      getMediaSettings: vi.fn(async () => MEDIA),
      setMediaSettings: vi.fn(async (patch: Partial<MediaSettings>) => ({
        ...MEDIA,
        ...patch,
      })),
      getMediaTools: vi.fn(async () => TOOLS),
      ...over,
    };
  }

  it("ships both transcription switches off and persists each on its own", async () => {
    const setMediaSettings = vi.fn(async (patch: Partial<MediaSettings>) => ({
      ...MEDIA,
      ...patch,
    }));
    render(<SettingsTab client={makeClient({ setMediaSettings })} />);

    const voice = (await screen.findByTestId(
      "media-voice-notes",
    )) as HTMLInputElement;
    const video = screen.getByTestId("media-video-audio") as HTMLInputElement;
    await waitFor(() => expect(voice.checked).toBe(false));
    expect(video.checked).toBe(false);

    fireEvent.click(voice);
    await waitFor(() =>
      expect(setMediaSettings).toHaveBeenCalledWith({
        voice_notes_enabled: true,
      }),
    );
    // Turning voice notes on says nothing about the audio inside videos.
    expect(setMediaSettings).not.toHaveBeenCalledWith({
      video_audio_enabled: true,
    });
  });

  it("says it is local and free of tokens, and that it is neither fast nor reliable", async () => {
    render(<SettingsTab client={makeClient()} />);
    await screen.findByTestId("media-voice-notes");

    const copy = screen.getByText(/Whisper runs on this Mac/);
    expect(copy.textContent).toContain("no tokens are spent");
    expect(copy.textContent).toContain("a long recording takes a while");
    expect(copy.textContent).toContain("unreliable on noisy audio");
    // The two things the detector cannot do: it is structural, so a fluent
    // invention survives it, and accuracy is a property of the chosen model.
    expect(copy.textContent).toContain("fluent text nobody said");
    expect(copy.textContent).toContain("smaller ones are much weaker");
  });

  it("reads each binary's version off the worker", async () => {
    render(<SettingsTab client={makeClient()} />);

    await waitFor(() =>
      expect(screen.getByTestId("tool-ffmpeg").textContent).toBe("8.1"),
    );
    expect(screen.getByTestId("tool-whisper").textContent).toBe("1.9.1");
    expect(screen.queryByTestId("toolchain-missing")).toBeNull();
  });

  it("says out loud when a binary did not ship, instead of failing per recording", async () => {
    const getMediaTools = vi.fn(async () => ({
      ...TOOLS,
      whisper: { path: null, present: false, version: null },
    }));
    render(<SettingsTab client={makeClient({ getMediaTools })} />);

    await waitFor(() =>
      expect(screen.getByTestId("tool-whisper").textContent).toBe("Missing"),
    );
    expect(screen.getByTestId("toolchain-missing")).toBeTruthy();
  });

  it("shows each model's size and whether it is on disk", async () => {
    render(<SettingsTab client={makeClient()} />);

    await waitFor(() =>
      expect(screen.getByTestId("whisper-status-tiny").textContent).toBe(
        "74.1 MB · Not downloaded",
      ),
    );
    expect(
      screen.getByTestId("whisper-status-large-v3-turbo-q5_0").textContent,
    ).toBe("547.4 MB · Ships with the app");
    expect(screen.getByTestId("whisper-status-large-v3").textContent).toBe(
      "2.88 GB · Not downloaded",
    );
  });

  it("will not let a model that is not here be selected", async () => {
    render(<SettingsTab client={makeClient()} />);

    const tiny = (await screen.findByTestId(
      "whisper-select-tiny",
    )) as HTMLInputElement;
    expect(tiny.disabled).toBe(true);
    const bundled = screen.getByTestId(
      "whisper-select-large-v3-turbo-q5_0",
    ) as HTMLInputElement;
    expect(bundled.disabled).toBe(false);
    expect(bundled.checked).toBe(true);
  });

  it("persists a model change as a whisper_model patch", async () => {
    const setMediaSettings = vi.fn(async (patch: Partial<MediaSettings>) => ({
      ...MEDIA,
      ...patch,
    }));
    const getMediaTools = vi.fn(async () => ({
      ...TOOLS,
      models: [
        model("tiny", { bytes: 77_691_713, present: true, bytesOnDisk: 77_691_713 }),
        model("large-v3-turbo-q5_0", {
          bundled: true,
          present: true,
          bytesOnDisk: 574_041_195,
          selected: true,
        }),
      ],
    }));
    render(<SettingsTab client={makeClient({ setMediaSettings, getMediaTools })} />);

    fireEvent.click(await screen.findByTestId("whisper-select-tiny"));
    await waitFor(() =>
      expect(setMediaSettings).toHaveBeenCalledWith({ whisper_model: "tiny" }),
    );
  });

  it("starts a download and adopts the rows the worker hands back", async () => {
    const downloadWhisperModel = vi.fn(async (id: string) => ({
      id,
      download: {
        id,
        status: "downloading" as const,
        receivedBytes: 0,
        totalBytes: null,
        error: null,
      },
      models: TOOLS.models.map((m) =>
        m.id === id
          ? {
              ...m,
              download: {
                id,
                status: "downloading" as const,
                receivedBytes: 12_000_000,
                totalBytes: 77_691_713,
                error: null,
              },
            }
          : m,
      ),
    }));
    render(<SettingsTab client={makeClient({ downloadWhisperModel })} />);

    fireEvent.click(await screen.findByTestId("whisper-download-tiny"));
    await waitFor(() =>
      expect(downloadWhisperModel).toHaveBeenCalledWith("tiny"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("whisper-status-tiny").textContent).toBe(
        "74.1 MB · Downloading — 11.4 MB of 74.1 MB",
      ),
    );
    // A download in flight is a thing you stop, not one you start again.
    expect(screen.queryByTestId("whisper-download-tiny")).toBeNull();
    expect(screen.getByTestId("whisper-cancel-tiny")).toBeTruthy();
  });

  it("reports why a download failed rather than showing it as absent", async () => {
    const getMediaTools = vi.fn(async () => ({
      ...TOOLS,
      models: [
        model("tiny", {
          bytes: 77_691_713,
          download: {
            id: "tiny",
            status: "error" as const,
            receivedBytes: 0,
            totalBytes: null,
            error: "the download server answered 404 Not Found",
          },
        }),
      ],
    }));
    render(<SettingsTab client={makeClient({ getMediaTools })} />);

    await waitFor(() =>
      expect(screen.getByTestId("whisper-status-tiny").textContent).toContain(
        "Download failed — the download server answered 404",
      ),
    );
    // Still offered, because retrying is the only thing to do about it.
    expect(screen.getByTestId("whisper-download-tiny")).toBeTruthy();
  });

  it("cancels an in-flight download", async () => {
    const getMediaTools = vi.fn(async () => ({
      ...TOOLS,
      models: [
        model("tiny", {
          bytes: 77_691_713,
          download: {
            id: "tiny",
            status: "downloading" as const,
            receivedBytes: 5,
            totalBytes: 77_691_713,
            error: null,
          },
        }),
      ],
    }));
    const cancelWhisperModel = vi.fn(async (id: string) => ({
      id,
      cancelled: true,
      models: [model("tiny", { bytes: 77_691_713 })],
    }));
    render(<SettingsTab client={makeClient({ getMediaTools, cancelWhisperModel })} />);

    fireEvent.click(await screen.findByTestId("whisper-cancel-tiny"));
    await waitFor(() => expect(cancelWhisperModel).toHaveBeenCalledWith("tiny"));
    await waitFor(() =>
      expect(screen.getByTestId("whisper-download-tiny")).toBeTruthy(),
    );
  });

  it("offers no delete for the bundled model, and none for the selected one", async () => {
    const getMediaTools = vi.fn(async () => ({
      ...TOOLS,
      models: [
        model("tiny", {
          bytes: 77_691_713,
          present: true,
          bytesOnDisk: 77_691_713,
          selected: true,
        }),
        model("large-v3-turbo-q5_0", {
          bundled: true,
          present: true,
          bytesOnDisk: 574_041_195,
        }),
      ],
    }));
    render(<SettingsTab client={makeClient({ getMediaTools })} />);

    await screen.findByTestId("whisper-row-tiny");
    // The bundled one lives inside the app; there is nothing to remove.
    expect(screen.queryByTestId("whisper-delete-large-v3-turbo-q5_0")).toBeNull();
    // Deleting the model in use would break every recording — the worker
    // refuses it, and the button says so before it is pressed.
    expect(
      (screen.getByTestId("whisper-delete-tiny") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("deletes a downloaded model and shows the worker's refusal verbatim", async () => {
    const getMediaTools = vi.fn(async () => ({
      ...TOOLS,
      models: [
        model("tiny", { bytes: 77_691_713, present: true, bytesOnDisk: 77_691_713 }),
      ],
    }));
    const deleteWhisperModel = vi.fn(async () => {
      throw new Error("this is the model transcription uses");
    });
    render(<SettingsTab client={makeClient({ getMediaTools, deleteWhisperModel })} />);

    fireEvent.click(await screen.findByTestId("whisper-delete-tiny"));
    await waitFor(() =>
      expect(screen.getByTestId("whisper-model-error").textContent).toBe(
        "this is the model transcription uses",
      ),
    );
  });

  it("names the folder downloads land in, outside the app", async () => {
    render(<SettingsTab client={makeClient()} />);
    await waitFor(() =>
      expect(screen.getByText("/Users/x/SuperTwinV11/models")).toBeTruthy(),
    );
  });

  it("degrades to dashes when the worker cannot answer", async () => {
    const getMediaTools = vi.fn(async () => {
      throw new Error("offline");
    });
    render(<SettingsTab client={makeClient({ getMediaTools })} />);

    await waitFor(() =>
      expect(screen.getByTestId("tool-ffmpeg").textContent).toBe("—"),
    );
    expect(screen.queryByTestId("whisper-row-tiny")).toBeNull();
    expect(screen.queryByTestId("toolchain-missing")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Search by meaning (docs/v6-spec.md §1, tier 3). Three things have to line up
// before this does anything — the switch, the bundled encoder, the downloaded
// weights — and the card's job is to say which one is missing rather than a
// single "off" the user cannot act on.
// ---------------------------------------------------------------------------

describe("SettingsTab search card", () => {
  type SearchClient = Pick<WorkerClient, "getHealth" | "getQuota"> &
    Partial<Pick<WorkerClient, "getSemanticState" | "setSemanticEnabled" |
      "downloadEmbeddingModel" | "cancelEmbeddingModel" | "deleteEmbeddingModel">>;

  function semantic(over: Partial<SemanticState> = {}): SemanticState {
    return {
      enabled: false,
      availability: "no-model",
      reason: "semantic search is off: the encoder is not downloaded yet (129 MB)",
      model: "Xenova/multilingual-e5-small",
      dim: 384,
      indexed: 0,
      embeddable: 643,
      runtimeInstalled: true,
      modelBytes: 135_392_016,
      modelDir: "/Users/x/SuperTwinV11/models/embeddings",
      bundled: false,
      present: false,
      files: [],
      download: null,
      ...over,
    };
  }

  function makeClient(over: Partial<SearchClient> = {}): SearchClient {
    return {
      ...offlineHealth,
      getSemanticState: vi.fn(async () => semantic()),
      ...over,
    };
  }

  it("ships off, and names the download rather than just saying off", async () => {
    render(<SettingsTab client={makeClient()} />);

    const sw = (await screen.findByTestId("semantic-enabled")) as HTMLInputElement;
    expect(sw.checked).toBe(false);
    expect(screen.getByTestId("semantic-model-status").textContent).toContain(
      "Not downloaded",
    );
    expect(screen.getByTestId("semantic-download")).toBeTruthy();
    expect(screen.getByTestId("semantic-indexed").textContent).toBe("Not running");
  });

  it("offers no download and no delete once the encoder ships with the app", async () => {
    // v7 §7 bundles it. Offering to fetch what is already here reads as broken,
    // and Delete would either lie or ask to be reached into a signed .app.
    const getSemanticState = vi.fn(async () =>
      semantic({
        availability: "ready",
        reason: "Xenova/multilingual-e5-small (384d) loaded",
        bundled: true,
        present: true,
        indexed: 643,
        modelDir: "/Applications/SuperTwinV11.app/Contents/Resources/models/embeddings",
      }),
    );
    render(<SettingsTab client={makeClient({ getSemanticState })} />);

    const status = await screen.findByTestId("semantic-model-status");
    expect(status.textContent).toContain("Inside the app");
    expect(screen.queryByTestId("semantic-download")).toBeNull();
    expect(screen.queryByTestId("semantic-delete")).toBeNull();
    expect(screen.queryByTestId("semantic-cancel")).toBeNull();
    // And the switch's own copy stops sending the reader to a download.
    const card = screen.getByTestId("semantic-card");
    expect(card.textContent).not.toContain("downloaded below");
    expect(card.textContent).toContain("already inside the app");
  });

  it("turning it on with no weights says so instead of claiming it works", async () => {
    const setSemanticEnabled = vi.fn(async () =>
      semantic({ enabled: true, availability: "no-model" }),
    );
    render(<SettingsTab client={makeClient({ setSemanticEnabled })} />);

    fireEvent.click(await screen.findByTestId("semantic-enabled"));
    await waitFor(() => expect(setSemanticEnabled).toHaveBeenCalledWith(true));

    const note = await screen.findByTestId("semantic-reason");
    expect(note.textContent).toContain("not downloaded yet");
    // On but inert is the one state a switch cannot show by itself.
    expect(note.className).toContain("settings__note--warn");
  });

  it("shows a download in progress and offers to cancel it", async () => {
    const getSemanticState = vi.fn(async () =>
      semantic({
        download: {
          status: "downloading",
          receivedBytes: 20_000_000,
          totalBytes: 135_392_016,
          file: "onnx/model_quantized.onnx",
          error: null,
        },
      }),
    );
    render(<SettingsTab client={makeClient({ getSemanticState })} />);

    const status = await screen.findByTestId("semantic-model-status");
    expect(status.textContent).toContain("Downloading");
    expect(screen.getByTestId("semantic-cancel")).toBeTruthy();
    expect(screen.queryByTestId("semantic-download")).toBeNull();
  });

  it("reports a failed download with the worker's own reason", async () => {
    const getSemanticState = vi.fn(async () =>
      semantic({
        download: {
          status: "error",
          receivedBytes: 0,
          totalBytes: 135_392_016,
          file: "config.json",
          error: "config.json does not match the pinned checksum",
        },
      }),
    );
    render(<SettingsTab client={makeClient({ getSemanticState })} />);

    await waitFor(() =>
      expect(
        screen.getByTestId("semantic-model-status").textContent,
      ).toContain("pinned checksum"),
    );
  });

  it("once ready, counts how far the index has got and offers Delete", async () => {
    const getSemanticState = vi.fn(async () =>
      semantic({
        enabled: true,
        availability: "ready",
        present: true,
        indexed: 200,
        embeddable: 643,
      }),
    );
    render(<SettingsTab client={makeClient({ getSemanticState })} />);

    await waitFor(() =>
      expect(screen.getByTestId("semantic-indexed").textContent).toBe(
        "200 of 643 messages",
      ),
    );
    expect(screen.getByTestId("semantic-delete")).toBeTruthy();
    expect(screen.getByTestId("semantic-indexing")).toBeTruthy();
    expect(screen.queryByTestId("semantic-reason")).toBeNull();
  });

  it("says so when the encoder did not ship with this build", async () => {
    const getSemanticState = vi.fn(async () =>
      semantic({ runtimeInstalled: false, availability: "no-runtime" }),
    );
    render(<SettingsTab client={makeClient({ getSemanticState })} />);

    await waitFor(() =>
      expect(screen.getByTestId("semantic-runtime").textContent).toBe("Missing"),
    );
    expect(screen.getByTestId("semantic-runtime-missing")).toBeTruthy();
  });

  it("surfaces a failure to change the setting rather than flipping anyway", async () => {
    const setSemanticEnabled = vi.fn(async () => {
      throw new Error("worker offline");
    });
    render(<SettingsTab client={makeClient({ setSemanticEnabled })} />);

    fireEvent.click(await screen.findByTestId("semantic-enabled"));
    await waitFor(() =>
      expect(screen.getByTestId("semantic-error").textContent).toBe(
        "worker offline",
      ),
    );
    expect(
      (screen.getByTestId("semantic-enabled") as HTMLInputElement).checked,
    ).toBe(false);
  });

  it("degrades to a disabled switch when the worker cannot answer", async () => {
    const getSemanticState = vi.fn(async () => {
      throw new Error("offline");
    });
    render(<SettingsTab client={makeClient({ getSemanticState })} />);

    await waitFor(() =>
      expect(
        (screen.getByTestId("semantic-enabled") as HTMLInputElement).disabled,
      ).toBe(true),
    );
    expect(screen.queryByTestId("semantic-download")).toBeNull();
    expect(screen.getByTestId("semantic-indexed").textContent).toBe("—");
  });

  it("names the folder the encoder lands in, outside the app", async () => {
    render(<SettingsTab client={makeClient()} />);
    await waitFor(() =>
      expect(
        screen.getByText("/Users/x/SuperTwinV11/models/embeddings"),
      ).toBeTruthy(),
    );
  });
});

// ===========================================================================
// The encoder catalogue: four models, one active, laid out like the
// transcription picker above it.
// ===========================================================================

type RegistryClient = Parameters<typeof SettingsTab>[0] extends { client?: infer C }
  ? NonNullable<C>
  : never;

function embModel(over: Partial<EmbeddingModelRow> = {}): EmbeddingModelRow {
  return {
    id: "Xenova/multilingual-e5-small",
    upstream: null,
    source: "https://huggingface.co/Xenova/multilingual-e5-small",
    revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
    label: "Multilingual E5 Small",
    note: "Ships inside the app. 384 dimensions, fastest of the four.",
    dim: 384,
    bytes: 135_474_016,
    bundled: true,
    recommended: false,
    active: true,
    present: true,
    indexed: 643,
    files: [],
    download: null,
    ...over,
  };
}

const GEMMA = embModel({
  id: "onnx-community/embeddinggemma-300m-ONNX",
  upstream: "google/embeddinggemma-300m",
  label: "EmbeddingGemma 300M",
  note: "The best quality under 500M parameters.",
  dim: 768,
  bytes: 330_941_102,
  bundled: false,
  recommended: true,
  active: false,
  present: false,
  indexed: 0,
});

function embRegistry(over: Partial<EmbeddingRegistry> = {}): EmbeddingRegistry {
  return {
    active: "Xenova/multilingual-e5-small",
    models: [embModel(), GEMMA],
    swap: null,
    benchmark: null,
    benchmarkRunning: null,
    ...over,
  };
}

function embClient(over: Record<string, unknown> = {}): RegistryClient {
  return {
    ...offlineHealth,
    getEmbeddingRegistry: vi.fn(async () => embRegistry()),
    ...over,
  } as RegistryClient;
}

describe("SettingsTab encoder catalogue", () => {
  it("names the audio picker as transcription, so two model lists never read as one", async () => {
    render(<SettingsTab client={embClient()} />);
    expect(
      await screen.findByText("Audio Transcription Model Options"),
    ).toBeTruthy();
    expect(await screen.findByText("Search Model Options")).toBeTruthy();
  });

  it("marks the upgrade as recommended and names the model the user has heard of", async () => {
    render(<SettingsTab client={embClient()} />);

    const row = await screen.findByTestId(
      "embedding-model-onnx-community/embeddinggemma-300m-ONNX",
    );
    expect(within(row).getByText("Recommended")).toBeTruthy();
    // The runnable artifact is an ONNX export; the sentence still says whose
    // model it is, because that is what the reader is choosing.
    expect(row.textContent).toContain("google/embeddinggemma-300m");
    expect(row.textContent).toContain("Not downloaded");
    expect(
      screen.getByTestId(
        "embedding-download-onnx-community/embeddinggemma-300m-ONNX",
      ),
    ).toBeTruthy();
  });

  it("cannot select a model whose weights are not on disk", async () => {
    render(<SettingsTab client={embClient()} />);
    const radio = (await screen.findByTestId(
      "embedding-select-onnx-community/embeddinggemma-300m-ONNX",
    )) as HTMLInputElement;
    // A selection pointing at nothing would fail every search, not one.
    expect(radio.disabled).toBe(true);
    expect(radio.checked).toBe(false);
  });

  it("never offers to delete the bundled model that is in use", async () => {
    render(<SettingsTab client={embClient()} />);
    await screen.findByTestId("embedding-models-card");
    expect(
      screen.queryByTestId("embedding-delete-Xenova/multilingual-e5-small"),
    ).toBeNull();
    expect(
      screen.getByTestId("embedding-model-status-Xenova/multilingual-e5-small")
        .textContent,
    ).toContain("In use");
  });

  it("selecting a downloaded model starts the rebuild rather than flipping a pointer", async () => {
    const id = "onnx-community/embeddinggemma-300m-ONNX";
    const activateEmbeddingModel = vi.fn(async () => embRegistry());
    render(
      <SettingsTab
        client={embClient({
          getEmbeddingRegistry: vi.fn(async () =>
            embRegistry({ models: [embModel(), { ...GEMMA, present: true }] }),
          ),
          activateEmbeddingModel,
        })}
      />,
    );

    const radio = await screen.findByTestId(`embedding-select-${id}`);
    fireEvent.click(radio);
    await waitFor(() => expect(activateEmbeddingModel).toHaveBeenCalledWith(id));
  });

  it("says the old model is still answering while the new index is built", async () => {
    render(
      <SettingsTab
        client={embClient({
          getEmbeddingRegistry: vi.fn(async () =>
            embRegistry({
              swap: {
                fromModel: "Xenova/multilingual-e5-small",
                toModel: "onnx-community/embeddinggemma-300m-ONNX",
                phase: "embedding",
                total: 643,
                embedded: 128,
                startedAt: "2026-08-13T00:00:00.000Z",
                finishedAt: null,
                error: null,
              },
            }),
          ),
        })}
      />,
    );

    const status = await screen.findByTestId("embedding-swap-status");
    expect(status.textContent).toContain("128");
    expect(status.textContent).toContain("Search is still using");
    expect(status.textContent).toContain("Xenova/multilingual-e5-small");
    // A swap in flight cannot be raced by another one.
    const radio = screen.getByTestId(
      "embedding-select-onnx-community/embeddinggemma-300m-ONNX",
    ) as HTMLInputElement;
    expect(radio.disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Processing → parallel calls (arch §4.4.1).
//
// One number, LLM calls only, and the copy has to say what it costs in RAM and
// in rate limit — a user who drags it to 16 on an 8 GB Mac needs to be told
// that it will run SLOWER, before they do it.
// ---------------------------------------------------------------------------
describe("SettingsTab processing — parallel calls", () => {
  function makeClient() {
    return {
      getHealth: vi.fn(async () => ({ ok: true, version: "0.0.1" })),
      getQuota: vi.fn(async () => QUOTA),
    };
  }

  afterEach(() => {
    window.localStorage.clear();
  });

  it("is a 1–16 slider that defaults to 8", async () => {
    render(<SettingsTab client={makeClient()} />);
    const slider = (await screen.findByTestId("llm-parallel")) as HTMLInputElement;
    expect(slider.type).toBe("range");
    expect(slider.min).toBe("1");
    expect(slider.max).toBe("16");
    expect(slider.value).toBe("8");
    expect(screen.getByTestId("llm-parallel-value").textContent).toBe("8");
  });

  it("carries the RAM / rate-limit note verbatim", async () => {
    render(<SettingsTab client={makeClient()} />);
    const note = await screen.findByTestId("llm-parallel-note");
    expect(note.textContent).toBe(LLM_PARALLEL_NOTE);
    // The three facts a user acts on must be in there, not paraphrased away.
    expect(note.textContent).toContain("250–350 MB");
    expect(note.textContent).toContain("8 parallel ≈ 2–3 GB · 16 parallel ≈ 4–6 GB.");
    expect(note.textContent).toContain("slower");
    expect(note.textContent).toContain("rate limit sooner");
    expect(note.textContent).toContain(
      "Local transcription and embeddings have their own limits",
    );
  });

  it("moves, shows the new value, and survives a remount", async () => {
    const { unmount } = render(<SettingsTab client={makeClient()} />);
    const slider = (await screen.findByTestId("llm-parallel")) as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "16" } });
    expect(screen.getByTestId("llm-parallel-value").textContent).toBe("16");

    unmount();
    render(<SettingsTab client={makeClient()} />);
    const again = (await screen.findByTestId("llm-parallel")) as HTMLInputElement;
    expect(again.value).toBe("16");
  });

  it("clamps a stored value that is out of range rather than trusting it", async () => {
    window.localStorage.setItem("supertwin.concurrency.llm", "99");
    render(<SettingsTab client={makeClient()} />);
    const slider = (await screen.findByTestId("llm-parallel")) as HTMLInputElement;
    expect(slider.value).toBe("16");
  });
});

// ===========================================================================
// Settings → Usage (arch §4.4.4, evals U). The panel exists because the prior
// build shipped three accounting lies on screen: input_tokens shown as the
// total input, input and cache read as two separate spends, and a cost of "—"
// next to real tokens because cost and tokens were summed over different rows.
// ===========================================================================

const USAGE: UsageSummary = {
  window: "7d",
  byRole: [
    {
      role: "extract",
      model: "claude-sonnet-5",
      inputTokens: 412_880,
      cacheCreationTokens: 128_400,
      cacheReadTokens: 96_200,
      totalInputTokens: 637_480,
      outputTokens: 84_110,
      billableTokens: 566_890,
      costUsd: 1.82,
      runCount: 900,
      cacheMinimumTokens: 1024,
      cacheExpectedZero: false,
    },
    {
      role: "media",
      model: "claude-haiku-4.5",
      inputTokens: 980_200,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalInputTokens: 980_200,
      outputTokens: 41_300,
      billableTokens: 1_021_500,
      costUsd: 0.98,
      runCount: 384,
      cacheMinimumTokens: 4096,
      cacheExpectedZero: true,
    },
  ],
  totals: {
    inputTokens: 1_393_080,
    cacheCreationTokens: 128_400,
    cacheReadTokens: 96_200,
    totalInputTokens: 1_617_680,
    outputTokens: 125_410,
    billableTokens: 1_588_390,
    costUsd: 2.8,
    runCount: 1284,
  },
  cache: {
    hitRate: 0.12,
    belowMinimumModels: ["claude-haiku-4.5"],
    minimumTokens: 4096,
  },
  runs: { ok: 1284, retried: 6, quarantined: 2, error: 0, other: 0, total: 1292 },
  thisImport: {
    mode: "bootstrap",
    cohorts: 12,
    cohortsDone: 8,
    events: 3028,
    eventsDone: 2150,
    runCount: 1100,
    spend: {
      spentUsd: 2.21,
      fractionComplete: 0.71,
      projectedTotalUsd: 3.11,
      remainingUsd: 0.9,
    },
  },
};

describe("SettingsTab usage board", () => {
  function usageClient(summary: UsageSummary = USAGE) {
    return {
      getHealth: vi.fn(async () => ({ ok: true, version: "0.0.1" })),
      getQuota: vi.fn(async () => QUOTA),
      getUsage: vi.fn(async (_window?: UsageWindow) => summary),
    };
  }

  it("U-001: every role row renders total input, and it is the sum of its parts", async () => {
    render(<SettingsTab client={usageClient()} />);
    await waitFor(() =>
      expect(screen.getByTestId("usage-row-extract-total-input").textContent).toBe(
        "637,480",
      ),
    );
    expect(screen.getByTestId("usage-row-media-total-input").textContent).toBe(
      "980,200",
    );
    // The 412,880 fresh figure is present, but never on its own as "input".
    const row = screen.getByTestId("usage-row-extract");
    expect(row.textContent).toContain("412,880");
    expect(row.textContent).toContain("637,480");
  });

  it("U-002/U-003: the three parts are shown WITH their sum, not as separate spend", async () => {
    render(<SettingsTab client={usageClient()} />);
    await waitFor(() =>
      expect(screen.getByTestId("usage-total-input").textContent).toBe("1,617,680"),
    );
    const line = screen.getByTestId("usage-total-input").parentElement!;
    expect(line.textContent).toContain("fresh 1,393,080");
    expect(line.textContent).toContain("write 128,400");
    expect(line.textContent).toContain("read 96,200");
    // And the chat/media grids carry the same identity line.
    expect(screen.getByTestId("quota-total-input").textContent).toBe("59,885");
    expect(screen.getByTestId("media-spend-total-input").textContent).toBe(
      "59,757",
    );
  });

  it("U-002: the chat grid never labels post-breakpoint input as the total", async () => {
    render(<SettingsTab client={usageClient()} />);
    await waitFor(() =>
      expect(screen.getByTestId("quota-input").textContent).toBe("1,234"),
    );
    const cell = screen.getByTestId("quota-input").parentElement!;
    expect(cell.textContent).toContain("Fresh input");
    expect(cell.textContent).not.toContain("Total");
  });

  it("U-004/U-007: cost renders from the same aggregate, never a dash beside spend", async () => {
    render(<SettingsTab client={usageClient()} />);
    await waitFor(() =>
      expect(screen.getByTestId("usage-cost-total").textContent).toBe("$2.80"),
    );
    expect(screen.getByTestId("usage-cost-by-role").textContent).toContain(
      "extract $1.82",
    );
    expect(screen.getByTestId("usage-cost-by-role").textContent).toContain(
      "media $0.98",
    );
    expect(screen.getByTestId("usage-cost-total").textContent).not.toBe("—");
    expect(
      screen.getByTestId("usage-cost-total").parentElement?.textContent,
    ).toContain("reported by the Claude CLI, not estimated");
  });

  it("U-008: the blocks are labelled by the role they actually contain", async () => {
    render(<SettingsTab client={usageClient()} />);
    await waitFor(() =>
      expect(screen.getByTestId("usage-row-extract").textContent).toContain(
        "extract (claude-sonnet-5)",
      ),
    );
    expect(screen.getByTestId("usage-row-media").textContent).toContain(
      "media (claude-haiku-4.5)",
    );
    expect(screen.queryByTestId("usage-row-chat")).toBeNull();
  });

  it("U-011/U-012: shows the measured hit rate with the haiku-minimum note", async () => {
    render(<SettingsTab client={usageClient()} />);
    await waitFor(() =>
      expect(screen.getByTestId("usage-cache-hit-rate").textContent).toBe("12%"),
    );
    const note = screen.getByTestId("usage-cache-note").textContent ?? "";
    expect(note).toContain("claude-haiku-4.5");
    expect(note).toContain("4,096-token minimum");
    expect(note).toContain("this is expected");
  });

  it("drops the note when nothing is below its minimum", async () => {
    const summary: UsageSummary = {
      ...USAGE,
      cache: { hitRate: 0.44, belowMinimumModels: [], minimumTokens: null },
    };
    render(<SettingsTab client={usageClient(summary)} />);
    await waitFor(() =>
      expect(screen.getByTestId("usage-cache-hit-rate").textContent).toBe("44%"),
    );
    expect(screen.queryByTestId("usage-cache-note")).toBeNull();
  });

  it("dashes an unmeasured hit rate rather than calling it 0%", async () => {
    const summary: UsageSummary = {
      ...USAGE,
      cache: { hitRate: null, belowMinimumModels: [], minimumTokens: null },
    };
    render(<SettingsTab client={usageClient(summary)} />);
    await waitFor(() =>
      expect(screen.getByTestId("usage-cache-hit-rate").textContent).toBe("—"),
    );
  });

  it("shows run counts by outcome", async () => {
    render(<SettingsTab client={usageClient()} />);
    await waitFor(() => {
      const t = screen.getByTestId("usage-run-counts").textContent ?? "";
      expect(t).toContain("1,284 ok");
      expect(t).toContain("6 retried");
      expect(t).toContain("2 quarantined");
    });
  });

  it("U-010: this import shows progress, spend-to-date and a projection", async () => {
    render(<SettingsTab client={usageClient()} />);
    await waitFor(() =>
      expect(screen.getByTestId("usage-import-spent").textContent).toBe("$2.21"),
    );
    expect(screen.getByTestId("usage-import-complete").textContent).toBe("71%");
    expect(screen.getByTestId("usage-import-remaining").textContent).toBe(
      "~$0.90 to go",
    );
    expect(screen.getByTestId("usage-this-import").textContent).toContain(
      "3,028 events",
    );
  });

  it("says the projection is pending rather than inventing one", async () => {
    const summary: UsageSummary = {
      ...USAGE,
      thisImport: {
        ...USAGE.thisImport,
        spend: {
          spentUsd: 0.2,
          fractionComplete: 0,
          projectedTotalUsd: null,
          remainingUsd: null,
        },
      },
    };
    render(<SettingsTab client={usageClient(summary)} />);
    await waitFor(() =>
      expect(screen.getByTestId("usage-import-remaining").textContent).toBe(
        "projection pending",
      ),
    );
  });

  it("re-reads the whole aggregate when the window changes — never half of it", async () => {
    const client = usageClient();
    render(<SettingsTab client={client} />);
    await waitFor(() => expect(client.getUsage).toHaveBeenCalled());
    expect(client.getUsage.mock.calls[0][0]).toBe("7d");

    fireEvent.click(screen.getByTestId("usage-window-import"));
    await waitFor(() =>
      expect(
        client.getUsage.mock.calls.some((c) => c[0] === "import"),
      ).toBe(true),
    );
    expect(
      (screen.getByTestId("usage-window-import") as HTMLButtonElement).getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");
  });

  it("dashes the board while the worker is offline instead of showing stale money", async () => {
    const client = {
      ...offlineHealth,
      getUsage: vi.fn(async () => USAGE),
    };
    render(<SettingsTab client={client} />);
    await waitFor(() =>
      expect(screen.getByTestId("worker-status").textContent).toBe("Offline"),
    );
    expect(screen.getByTestId("usage-cost-total").textContent).toBe("—");
    expect(screen.getByTestId("usage-total-input").textContent).toBe("—");
    expect(screen.getByTestId("usage-tokens-empty")).toBeTruthy();
  });
});
