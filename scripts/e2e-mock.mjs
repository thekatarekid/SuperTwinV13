// ===========================================================================
// e2e-mock.mjs — Phase 1 end-to-end regression harness (no phone, no account).
//
// Drives the FULL worker <-> Go-daemon pipeline in MOCK mode and asserts the
// contract's observable behaviour (docs/PHASE1_CONTRACT.md §1-§6, §9):
//
//   pair -> import(all) -> inbox chats -> messages(ascending) -> FTS search ->
//   media (200 + image + non-empty) -> path-traversal rejected ->
//   restart + re-import(all) -> DEDUPE (0 new rows).
//
// Rev 6 (§R6.1/R6.2/R6.5) is asserted inline on the "all" run: unsaved-business
// name from history-sync (JioHome Offers) + real plain text (no "[business
// message]"), and a text-less media chat's label preview ("🎥 Video", never
// empty). A SEPARATE fresh-home run covers §R6.3 (import{24h} chats_total = the
// in-range count, < the full set, with done:true) and §R6.4 (extend{30d}
// paginates older history so a deep-history chat's coverage increases).
//
// Rev 7 is asserted in two places: §R7.2 (import completion) inline on the "all"
// run — the terminal backfill frame is done:true so the banner clears; and
// §R7.1 (latest-window paging) in the R6 run once the deep-history chat
// "Subhashree" has more messages than the page size — the default chat-detail
// window returns the NEWEST page (the tail, not the head), and a
// before="<ts>|<id>" cursor returns the immediately older page with NO overlap
// and NO gap (contiguous under the (ts, id) total order). The plateau path where
// chats_done < chats_total is unit-covered (wa/completion_test.go +
// mock TestMockPlateauCompletesViaQuietWindow).
//
// It is self-contained and adds NO new dependencies:
//   * builds the Go daemon to a temp path with `go build` (arm64/host),
//   * starts the worker with SUPERTWIN_WHATSAPP_MOCK=1 on a spare port + temp
//     home. Prefers the SHIPPED artifact `worker/bundle/worker.cjs` (run via
//     `node`) when present; otherwise falls back to `worker/src/index.ts` via
//     the repo-local `tsx`,
//   * talks to the API with the built-in global `fetch`,
//   * kills every child it spawns (no orphans) on every exit path.
//
// Exit code 0 = all checks passed; non-zero = a failure (printed in the summary).
//
// Usage:  node scripts/e2e-mock.mjs
// ===========================================================================

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");

const PORT = Number(process.env.E2E_PORT ?? 8901);
const BASE = `http://127.0.0.1:${PORT}`;

// ---- tiny assertion + reporting harness -----------------------------------
const results = [];
let failures = 0;
function check(name, cond, detail = "") {
  const ok = Boolean(cond);
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  const tag = ok ? "PASS" : "FAIL";
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}
function fatal(msg) {
  console.error(`\n[e2e-mock] FATAL: ${msg}`);
  cleanup();
  process.exit(1);
}

// ---- process + temp bookkeeping -------------------------------------------
let worker = null;
const tmpDirs = [];
function cleanup() {
  if (worker && !worker.killed) {
    try {
      worker.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  // Backstop: sweep any daemon spawned from our temp bin path.
  try {
    spawnSync("pkill", ["-f", "e2e-mock-daemon"], { stdio: "ignore" });
  } catch {
    /* ignore */
  }
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

// ---- helpers --------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}
async function postJson(path, obj) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(obj ?? {}),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function pollUntil(fn, { timeoutMs = 15000, everyMs = 200, label }) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (last) return last;
    await sleep(everyMs);
  }
  throw new Error(`timeout waiting for ${label ?? "condition"} (last=${JSON.stringify(last)})`);
}

// ---- 1. build the Go daemon to a temp path --------------------------------
function buildDaemon() {
  const goSrc = join(REPO, "sources", "whatsapp-go");
  if (!existsSync(goSrc)) fatal(`Go daemon source not found: ${goSrc}`);
  const binDir = mkdtempSync(join(tmpdir(), "e2e-mock-bin-"));
  tmpDirs.push(binDir);
  // Name carries a marker so cleanup's pkill sweep can find a stray daemon.
  const bin = join(binDir, "e2e-mock-daemon");
  console.log(`[e2e-mock] building Go daemon -> ${bin}`);
  const res = spawnSync("go", ["build", "-o", bin, "."], {
    cwd: goSrc,
    encoding: "utf8",
    env: { ...process.env, CGO_ENABLED: "0" },
  });
  if (res.status !== 0 || !existsSync(bin)) {
    fatal(`go build failed:\n${res.stdout ?? ""}${res.stderr ?? ""}`);
  }
  return bin;
}

// ---- 2. start the worker (mock) on PORT + temp home -----------------------
function startWorker(daemonBin, home, dbPath) {
  const bundle = join(REPO, "worker", "bundle", "worker.cjs");
  let cmd, args, usingBundle;
  if (existsSync(bundle)) {
    usingBundle = true;
    cmd = process.execPath; // node
    args = [bundle];
  } else {
    usingBundle = false;
    const tsx = join(REPO, "node_modules", ".bin", "tsx");
    if (!existsSync(tsx)) fatal(`no bundled worker.cjs and no tsx at ${tsx}`);
    cmd = tsx;
    args = [join(REPO, "worker", "src", "index.ts")];
  }
  console.log(
    `[e2e-mock] starting worker via ${usingBundle ? "bundled worker.cjs" : "tsx src"} on :${PORT}`,
  );
  const child = spawn(cmd, args, {
    cwd: usingBundle ? join(REPO, "worker", "bundle") : REPO,
    env: {
      ...process.env,
      SUPERTWIN_WHATSAPP_MOCK: "1",
      SUPERTWIN_WORKER_PORT: String(PORT),
      SUPERTWIN_HOME: home,
      SUPERTWIN_DB_PATH: dbPath,
      SUPERTWIN_WHATSAPP_BIN: daemonBin,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let ready = false;
  const onLine = (buf, isErr) => {
    const s = buf.toString();
    if (!ready && s.includes("WORKER_READY")) ready = true;
    if (process.env.E2E_VERBOSE) process[isErr ? "stderr" : "stdout"].write(s);
  };
  child.stdout.on("data", (b) => onLine(b, false));
  child.stderr.on("data", (b) => onLine(b, true));
  child.on("exit", (code, sig) => {
    if (process.env.E2E_VERBOSE) console.log(`[worker exited code=${code} sig=${sig}]`);
  });
  return { child, isReady: () => ready };
}

async function waitReady(handle, label) {
  await pollUntil(async () => handle.isReady(), {
    timeoutMs: 20000,
    everyMs: 150,
    label: `${label} WORKER_READY`,
  });
  // Health confirms the HTTP server is actually serving.
  await pollUntil(
    async () => {
      try {
        const h = await getJson("/api/health");
        return h.status === 200 && h.body?.ok === true;
      } catch {
        return false;
      }
    },
    { timeoutMs: 10000, label: `${label} /api/health` },
  );
}

// ---- main -----------------------------------------------------------------
async function main() {
  console.log("=== Phase 1 e2e-mock harness ===\n");

  const daemonBin = buildDaemon();
  const home = mkdtempSync(join(tmpdir(), "e2e-mock-home-"));
  tmpDirs.push(home);
  const dbPath = join(home, "supertwinv13.db");

  // ---- Run 1: pair -> import -> read/search/media/traversal ----------------
  let handle = startWorker(daemonBin, home, dbPath);
  worker = handle.child;
  await waitReady(handle, "run1");

  // health includes whatsapp state
  const health = await getJson("/api/health");
  check(
    "GET /api/health returns whatsapp state",
    health.status === 200 && health.body?.whatsapp?.state,
    `state=${health.body?.whatsapp?.state}`,
  );

  // pair -> status progresses toward online/paired
  const pair = await postJson("/api/whatsapp/pair", {});
  check("POST /api/whatsapp/pair ok", pair.status === 200 && pair.body?.ok === true);
  const paired = await pollUntil(
    async () => {
      const s = await getJson("/api/whatsapp/status");
      return s.body?.paired === true ? s.body : null;
    },
    { timeoutMs: 15000, label: "paired" },
  );
  check("status reaches paired", paired.paired === true, `state=${paired.state}`);

  // import(all) -> progress.done === true (validates the D1 completion fix)
  const imp = await postJson("/api/whatsapp/import", { range: "all" });
  check("POST /api/whatsapp/import{all} ok", imp.status === 200 && imp.body?.ok === true);
  const doneStatus = await pollUntil(
    async () => {
      const s = await getJson("/api/whatsapp/status");
      return s.body?.progress?.done === true ? s.body : null;
    },
    { timeoutMs: 15000, label: "import progress.done" },
  );
  check(
    "import completion observable (progress.done===true)",
    doneStatus.progress?.done === true,
    `messages=${doneStatus.progress?.messages}`,
  );

  // Rev 7 §R7.2 (import completion): a normal import MUST reach a terminal
  // backfill frame with done:true so the banner clears — the observable proof
  // that completion fires end-to-end (not stuck like the real 720/897 plateau).
  // The builtin fixture delivers history for every in-range chat, so it does
  // NOT plateau (chatsDone === chatsTotal here); the plateau path where
  // chatsDone < chatsTotal is proven by the daemon's completion_test.go
  // (TestQuietWindowCompletesWhenChatsPlateau) and the mock
  // TestMockPlateauCompletesViaQuietWindow. Here we assert the normal import
  // still completes with a backfill-phase done:true frame.
  check(
    "R7.2 import completion: terminal backfill frame is done:true (banner clears)",
    doneStatus.progress?.done === true && doneStatus.progress?.phase === "backfill",
    `phase=${doneStatus.progress?.phase} done=${doneStatus.progress?.done} chatsDone=${doneStatus.progress?.chatsDone} chatsTotal=${doneStatus.progress?.chatsTotal}`,
  );

  // Rev 2 §R2.1: the first backfill persists import state so relaunch never
  // re-asks the range. Status must report importDone:true + the chosen range.
  check(
    "R2.1 status.importDone===true after first import",
    doneStatus.importDone === true,
    `importDone=${doneStatus.importDone}`,
  );
  check(
    'R2.1 status.importRange==="all" after import{all}',
    doneStatus.importRange === "all",
    `importRange=${doneStatus.importRange}`,
  );

  // inbox chats (>=1 chat with counts)
  const chats = await getJson("/api/inbox/chats");
  const chatArr = Array.isArray(chats.body) ? chats.body : [];
  check(
    "GET /api/inbox/chats returns >=1 chat with counts",
    chatArr.length >= 1 && chatArr.every((c) => typeof c.messageCount === "number" && c.messageCount > 0),
    `chats=${chatArr.length}`,
  );
  const totalEventsRun1 = chatArr.reduce((n, c) => n + (c.messageCount ?? 0), 0);
  check("inbox chats sorted by lastTs desc", isDescByLastTs(chatArr));

  // Rev 2 §R2.4 (bug 7 dedupe): the fixture addresses "Hrishikesh" by BOTH a
  // LID (@lid, live) and a phone-number JID (@s.whatsapp.net, history-sync).
  // Canonicalization must collapse them to ONE channel — exactly once, and
  // never surface a channel whose name is a raw JID.
  const chatNames = chatArr.map((c) => c.name ?? "");
  const hrishCount = chatNames.filter((n) => n === "Hrishikesh").length;
  check(
    "R2.4 bug7: 'Hrishikesh' appears exactly once (LID+PN collapsed)",
    hrishCount === 1,
    `occurrences=${hrishCount} names=${JSON.stringify(chatNames)}`,
  );
  const rawJidNames = chatNames.filter(
    (n) => n.includes("@lid") || n.includes("@s.whatsapp.net") || n.includes("@g.us"),
  );
  check(
    "R2.4 bug7: no channel name is a raw JID",
    rawJidNames.length === 0,
    rawJidNames.length ? `raw=${JSON.stringify(rawJidNames)}` : "clean",
  );

  // Rev 2 §R2.4 (bug 4 names): chats carry human names, not bare numbers/JIDs.
  // Every fixture chat has a name; assert none is empty or a bare digit-run.
  const looksLikeNumberOrJid = (n) => n === "" || /^[+\d][\d@.:]*$/.test(n);
  const badNames = chatNames.filter(looksLikeNumberOrJid);
  check(
    "R2.4 bug4: chats carry human names (not bare numbers/JIDs)",
    badNames.length === 0,
    badNames.length ? `bad=${JSON.stringify(badNames)}` : `names=${JSON.stringify(chatNames)}`,
  );

  // Rev 2 §R2.4 (bug 2 self/from_me): the self chat exists as ONE channel and
  // carries at least one fromMe:true message (self + device-suffixed variants
  // collapse into it). Find it by a fromMe message rather than name.
  let selfChat = null;
  for (const c of chatArr) {
    const r = await getJson(`/api/inbox/chats/${encodeURIComponent(c.id)}/messages?limit=500`);
    const arr = Array.isArray(r.body) ? r.body : [];
    if (arr.some((m) => m.fromMe === true)) {
      selfChat = { chat: c, msgs: arr };
      break;
    }
  }
  check(
    "R2.4 bug2: a chat with a fromMe:true message exists (self/from_me ingested)",
    Boolean(selfChat) && selfChat.msgs.some((m) => m.fromMe === true),
    selfChat ? `chat="${selfChat.chat.name}" fromMe=${selfChat.msgs.filter((m) => m.fromMe).length}` : "none",
  );

  // Rev 4 §R4.2 (bug 16, business): the fixture's business account "Acme
  // Support" must appear with its VERIFIED BUSINESS NAME (not a bare number)
  // AND carry >=1 message (its non-plain TemplateMessage, extracted to text) —
  // i.e. NOT "No messages". Find it by name and confirm its template body.
  const bizChat = chatArr.find((c) => c.name === "Acme Support");
  check(
    "R4.2 bug16: business chat 'Acme Support' present with a name (not a number)",
    Boolean(bizChat) && !looksLikeNumberOrJid(bizChat.name),
    bizChat ? `name="${bizChat.name}" msgCount=${bizChat.messageCount}` : "missing",
  );
  if (bizChat) {
    check(
      "R4.2 bug16: business chat has >=1 message (template ingested, not 'No messages')",
      (bizChat.messageCount ?? 0) >= 1,
      `messageCount=${bizChat.messageCount}`,
    );
    const bizMsgs = await getJson(`/api/inbox/chats/${encodeURIComponent(bizChat.id)}/messages?limit=500`);
    const bizArr = Array.isArray(bizMsgs.body) ? bizMsgs.body : [];
    const templateMsg = bizArr.find((m) => (m.text ?? "").includes("Your order #4821 has shipped"));
    check(
      "R4.2 bug16: business TEMPLATE message text is present (extracted from TemplateMessage)",
      Boolean(templateMsg),
      templateMsg ? `text=${JSON.stringify(templateMsg.text)}` : `texts=${JSON.stringify(bizArr.map((m) => m.text))}`,
    );
  } else {
    check("R4.2 bug16: business chat has >=1 message (template ingested)", false, "no business chat");
    check("R4.2 bug16: business TEMPLATE message text is present", false, "no business chat");
  }

  // Rev 5 §R5.2 (bug 2, business real text): no message anywhere may surface the
  // bare placeholder "[template message]" — the daemon must extract the hydrated
  // body. Sweep every chat's messages and assert the placeholder never appears.
  let placeholderMsg = null;
  for (const c of chatArr) {
    const r = await getJson(`/api/inbox/chats/${encodeURIComponent(c.id)}/messages?limit=500`);
    const arr = Array.isArray(r.body) ? r.body : [];
    const p = arr.find((m) => (m.text ?? "").trim() === "[template message]");
    if (p) {
      placeholderMsg = { chat: c.name, text: p.text };
      break;
    }
  }
  check(
    "R5.2 bug2: no message surfaces the bare '[template message]' placeholder",
    placeholderMsg === null,
    placeholderMsg ? `chat="${placeholderMsg.chat}" text=${JSON.stringify(placeholderMsg.text)}` : "clean",
  );

  // Rev 5 §R5.3 (bug 3a, reactions): the fixture's 👍 reaction on MOM_0001 must
  // ATTACH to its target message (reactions:[{emoji,fromMe,actorName}]) and must
  // NOT appear as a standalone stream bubble (no kind='reaction' row), nor as the
  // chat's inbox preview, nor as an FTS search hit.
  const momChat = chatArr.find((c) => c.name === "Mom");
  if (momChat) {
    const mm = await getJson(`/api/inbox/chats/${encodeURIComponent(momChat.id)}/messages?limit=500`);
    const momMsgs = Array.isArray(mm.body) ? mm.body : [];
    const standaloneReactions = momMsgs.filter((m) => m.kind === "reaction");
    check(
      "R5.3 bug3a: reaction is NOT a standalone stream bubble (0 kind='reaction' rows)",
      standaloneReactions.length === 0,
      standaloneReactions.length ? `found=${standaloneReactions.length}` : "clean",
    );
    const target = momMsgs.find((m) => (m.id ?? "").endsWith("/MOM_0001"));
    const targetReactions = target?.reactions ?? [];
    check(
      "R5.3 bug3a: 👍 reaction attaches to its target message (MOM_0001)",
      Array.isArray(targetReactions) &&
        targetReactions.some((x) => x.emoji === "👍" && x.fromMe === true),
      target ? `reactions=${JSON.stringify(targetReactions)}` : "MOM_0001 target not found",
    );
    // No OTHER message in the chat should have accidentally inherited the reaction.
    const strayReacted = momMsgs.filter(
      (m) => !(m.id ?? "").endsWith("/MOM_0001") && (m.reactions ?? []).length > 0,
    );
    check(
      "R5.3 bug3a: only the target message carries the reaction (no stray attach)",
      strayReacted.length === 0,
      strayReacted.length ? `stray=${JSON.stringify(strayReacted.map((m) => m.id))}` : "clean",
    );
    // The reaction emoji must not become the chat's last-message preview.
    check(
      "R5.3 bug3a: reaction is NOT the inbox last-message preview",
      momChat.lastText !== "👍",
      `lastText=${JSON.stringify(momChat.lastText)}`,
    );
  } else {
    check("R5.3 bug3a: reaction is NOT a standalone stream bubble", false, "no Mom chat");
    check("R5.3 bug3a: 👍 reaction attaches to its target message (MOM_0001)", false, "no Mom chat");
    check("R5.3 bug3a: only the target message carries the reaction (no stray attach)", false, "no Mom chat");
    check("R5.3 bug3a: reaction is NOT the inbox last-message preview", false, "no Mom chat");
  }
  // A reaction emoji must never be an FTS search hit (searchEvents excludes them).
  const reactSearch = await getJson(`/api/inbox/search?q=${encodeURIComponent("👍")}`);
  const reactHits = Array.isArray(reactSearch.body) ? reactSearch.body : [];
  check(
    "R5.3 bug3a: reaction emoji is absent from FTS search results",
    reactHits.length === 0,
    reactHits.length ? `hits=${reactHits.length}` : "no hits (correct)",
  );

  // Rev 5 §R5.4 (bug 3b, quoted reply): the fixture's GRP_0005 quotes Bob's
  // GRP_0002. The reply message must return replyTo:{externalId,text,actorName}
  // with externalId pointing at the quoted target and the resolved quoted sender.
  const grpChat = chatArr.find((c) => c.name === "Weekend Trip");
  if (grpChat) {
    const gm = await getJson(`/api/inbox/chats/${encodeURIComponent(grpChat.id)}/messages?limit=500`);
    const grpMsgs = Array.isArray(gm.body) ? gm.body : [];
    const reply = grpMsgs.find((m) => (m.id ?? "").endsWith("/GRP_0005"));
    const replyTo = reply?.replyTo ?? null;
    check(
      "R5.4 bug3b: quoted reply (GRP_0005) returns replyTo pointing at GRP_0002",
      Boolean(replyTo) &&
        typeof replyTo.externalId === "string" &&
        replyTo.externalId.endsWith("/GRP_0002") &&
        (replyTo.text ?? "").length > 0,
      replyTo ? `replyTo=${JSON.stringify(replyTo)}` : "GRP_0005 reply/replyTo missing",
    );
    // Non-reply messages in the same chat must carry replyTo:null (no bleed).
    const strayReply = grpMsgs.filter(
      (m) => !(m.id ?? "").endsWith("/GRP_0005") && m.replyTo != null,
    );
    check(
      "R5.4 bug3b: only the reply message carries replyTo (no stray quoted block)",
      strayReply.length === 0,
      strayReply.length ? `stray=${JSON.stringify(strayReply.map((m) => m.id))}` : "clean",
    );
  } else {
    check("R5.4 bug3b: quoted reply (GRP_0005) returns replyTo pointing at GRP_0002", false, "no Weekend Trip group");
    check("R5.4 bug3b: only the reply message carries replyTo (no stray quoted block)", false, "no Weekend Trip group");
  }

  // Rev 4 §R4.3 (bug 17, noise): the status feed (status@broadcast) and
  // @newsletter channels are noise and MUST be filtered — no chat may carry
  // their fixture names ("Status" / "Some Channel"), and no chat name/id may
  // reference the broadcast/newsletter servers.
  const noiseNames = chatNames.filter((n) => n === "Status" || n === "Some Channel");
  check(
    "R4.3 bug17: no status/newsletter noise chats in the inbox list",
    noiseNames.length === 0,
    noiseNames.length ? `found=${JSON.stringify(noiseNames)}` : `names=${JSON.stringify(chatNames)}`,
  );
  const noiseIds = chatArr.filter(
    (c) => (c.id ?? "").includes("@broadcast") || (c.id ?? "").includes("@newsletter"),
  );
  check(
    "R4.3 bug17: no @broadcast/@newsletter channel ids in the inbox list",
    noiseIds.length === 0,
    noiseIds.length ? `ids=${JSON.stringify(noiseIds.map((c) => c.id))}` : "clean",
  );

  // Rev 4 §R4.3 (bug 17, empty chats): listInboxChats must return ONLY channels
  // with >=1 event — no "No messages" rows. (The existing chats assertion checks
  // messageCount>0 for every row; make the intent explicit.)
  const emptyChats = chatArr.filter((c) => (c.messageCount ?? 0) === 0);
  check(
    "R4.3 bug17: no empty (0-message) chats appear in the inbox list",
    emptyChats.length === 0,
    emptyChats.length ? `empty=${JSON.stringify(emptyChats.map((c) => c.name))}` : "all chats have messages",
  );

  // Rev 4 §R4.3 (bug 17, system spam): the self chat must NOT contain a
  // contentless system/protocol message (the fixture's SELF_SYS_1: kind=system,
  // empty text). Assert no such row surfaces in the self chat's messages.
  if (selfChat) {
    const contentlessSystem = selfChat.msgs.filter(
      (m) => m.kind === "system" && (!m.text || m.text.trim() === ""),
    );
    check(
      "R4.3 bug17: self chat has NO contentless system/protocol message (SELF_SYS_1 dropped)",
      contentlessSystem.length === 0,
      contentlessSystem.length ? `found=${contentlessSystem.length}` : "clean",
    );
  } else {
    check("R4.3 bug17: self chat has NO contentless system/protocol message", false, "no self chat");
  }

  // Rev 6 §R6.1 (bug 1 name): an UNSAVED business/OTP sender ("JioHome Offers")
  // must take its name from the history-sync Conversation.Name — a real NAME,
  // never a bare number. Its plain OTP text must be REAL, never "[business
  // message]" (bug 1 text, §R6.2 plain-text-first extraction).
  const otpChat = chatArr.find((c) => c.name === "JioHome Offers");
  check(
    "R6.1 bug1: unsaved business 'JioHome Offers' shows its NAME (not a number)",
    Boolean(otpChat) && !looksLikeNumberOrJid(otpChat.name),
    otpChat ? `name="${otpChat.name}"` : `names=${JSON.stringify(chatNames)}`,
  );
  if (otpChat) {
    const om = await getJson(`/api/inbox/chats/${encodeURIComponent(otpChat.id)}/messages?limit=500`);
    const otpMsgs = Array.isArray(om.body) ? om.body : [];
    const otpText = otpMsgs[0]?.text ?? "";
    check(
      "R6.2 bug1: business message text is REAL (not '[business message]'/'[template message]')",
      otpMsgs.length >= 1 &&
        otpText.includes("OTP") &&
        otpText !== "[business message]" &&
        otpText !== "[template message]",
      `text=${JSON.stringify(otpText)}`,
    );
  } else {
    check("R6.2 bug1: business message text is REAL", false, "no JioHome Offers chat");
  }

  // Rev 6 §R6.2 (bug 1 text): the bare "[business message]" placeholder must
  // NEVER surface anywhere (mirrors the R5.2 "[template message]" sweep).
  let bizPlaceholder = null;
  for (const c of chatArr) {
    const r = await getJson(`/api/inbox/chats/${encodeURIComponent(c.id)}/messages?limit=500`);
    const arr = Array.isArray(r.body) ? r.body : [];
    const p = arr.find((m) => (m.text ?? "").trim() === "[business message]");
    if (p) {
      bizPlaceholder = { chat: c.name, text: p.text };
      break;
    }
  }
  check(
    "R6.2 bug1: no message surfaces the bare '[business message]' placeholder",
    bizPlaceholder === null,
    bizPlaceholder ? `chat="${bizPlaceholder.chat}" text=${JSON.stringify(bizPlaceholder.text)}` : "clean",
  );

  // Rev 6 §R6.5 (bug 4, media preview): a media-only chat whose newest message is
  // a TEXT-LESS video ("Drone Footage") must show a kind-label preview
  // ("🎥 Video"), NOT an empty string or "No messages".
  const mediaOnlyChat = chatArr.find((c) => c.name === "Drone Footage");
  check(
    "R6.5 bug4: media-only chat 'Drone Footage' shows a non-empty label preview",
    Boolean(mediaOnlyChat) &&
      typeof mediaOnlyChat.lastText === "string" &&
      mediaOnlyChat.lastText.trim().length > 0 &&
      mediaOnlyChat.lastText !== "No messages" &&
      mediaOnlyChat.lastText.includes("Video"),
    mediaOnlyChat ? `lastText=${JSON.stringify(mediaOnlyChat.lastText)}` : "missing Drone Footage chat",
  );
  // No listed chat may have an empty/whitespace-only preview (bug 4 general).
  const emptyPreview = chatArr.filter(
    (c) => c.lastText == null || String(c.lastText).trim() === "",
  );
  check(
    "R6.5 bug4: no listed chat has an empty last-message preview",
    emptyPreview.length === 0,
    emptyPreview.length ? `empty=${JSON.stringify(emptyPreview.map((c) => c.name))}` : "all previews non-empty",
  );

  // messages ascending for the first chat, and locate a media event
  const firstChat = chatArr[0];
  const msgs = await getJson(`/api/inbox/chats/${encodeURIComponent(firstChat.id)}/messages?limit=500`);
  const msgArr = Array.isArray(msgs.body) ? msgs.body : [];
  check(
    `GET messages for "${firstChat.name}" ascending by ts`,
    msgArr.length >= 1 && isAscByTs(msgArr),
    `n=${msgArr.length}`,
  );

  // Find a media event across ALL chats (the fixture has a jpg in the Mom DM).
  let mediaMsg = null;
  for (const c of chatArr) {
    const r = await getJson(`/api/inbox/chats/${encodeURIComponent(c.id)}/messages?limit=500`);
    const arr = Array.isArray(r.body) ? r.body : [];
    const m = arr.find((x) => x.mediaUrl);
    if (m) {
      mediaMsg = m;
      break;
    }
  }
  check("found a message with mediaUrl", Boolean(mediaMsg), mediaMsg?.mediaUrl ?? "none");

  // media fetch -> 200 + image content-type + non-empty
  if (mediaMsg) {
    const mres = await fetch(`${BASE}${mediaMsg.mediaUrl}`);
    const buf = Buffer.from(await mres.arrayBuffer());
    const ct = mres.headers.get("content-type") ?? "";
    check(
      "GET media -> 200 + image + non-empty",
      mres.status === 200 && ct.startsWith("image/") && buf.length > 0,
      `status=${mres.status} type=${ct} bytes=${buf.length}`,
    );
  } else {
    check("GET media -> 200 + image + non-empty", false, "no media message to fetch");
  }

  // FTS search (>=1 hit + snippet). "dinner" appears in the Mom DM fixture.
  const search = await getJson(`/api/inbox/search?q=dinner`);
  const hits = Array.isArray(search.body) ? search.body : [];
  check(
    'GET /api/inbox/search?q=dinner -> >=1 hit + snippet',
    hits.length >= 1 && typeof hits[0].snippet === "string" && hits[0].snippet.length > 0,
    `hits=${hits.length} snippet=${JSON.stringify(hits[0]?.snippet)}`,
  );

  // path-traversal attempt -> rejected (404/400/403)
  const trav = await fetch(`${BASE}/api/media/..%2f..%2f..%2fetc%2fpasswd`);
  check(
    "path traversal rejected (media)",
    [400, 403, 404].includes(trav.status),
    `status=${trav.status}`,
  );

  // ---- Restart + re-import -> DEDUPE ---------------------------------------
  await gracefulStop(worker);
  worker = null;

  handle = startWorker(daemonBin, home, dbPath);
  worker = handle.child;
  await waitReady(handle, "run2");

  // Rev 2 §R2.1 (bug 6): import state must survive a worker restart WITHOUT
  // re-importing — this is what stops the app from re-asking the range on every
  // relaunch. Check status IMMEDIATELY after restart, before any re-pair/import.
  const restartStatus = await getJson("/api/whatsapp/status");
  check(
    "R2.1 bug6: importDone persists across worker restart (no re-import)",
    restartStatus.body?.importDone === true && restartStatus.body?.importRange === "all",
    `importDone=${restartStatus.body?.importDone} importRange=${restartStatus.body?.importRange}`,
  );

  // The mock daemon holds no persisted session, so after restart it boots back
  // to need_pairing. Re-pair (mimics reconnect) so it reaches online, then
  // re-import the same range — the DB (persisted at SUPERTWIN_DB_PATH) is what
  // must dedupe, not the daemon.
  await postJson("/api/whatsapp/pair", {});
  await pollUntil(
    async () => {
      const s = await getJson("/api/whatsapp/status");
      return s.body?.state === "online" || s.body?.paired === true ? s.body : null;
    },
    { timeoutMs: 15000, label: "run2 online" },
  );
  const imp2 = await postJson("/api/whatsapp/import", { range: "all" });
  check("run2 POST import{all} ok", imp2.status === 200 && imp2.body?.ok === true);
  await pollUntil(
    async () => {
      const s = await getJson("/api/whatsapp/status");
      return s.body?.progress?.done === true ? s.body : null;
    },
    { timeoutMs: 15000, label: "run2 import done" },
  );
  // Give the writer a beat to flush any final events.
  await sleep(500);

  const chats2 = await getJson("/api/inbox/chats");
  const chatArr2 = Array.isArray(chats2.body) ? chats2.body : [];
  const totalEventsRun2 = chatArr2.reduce((n, c) => n + (c.messageCount ?? 0), 0);
  check(
    "DEDUPE across restart: total event count unchanged",
    totalEventsRun2 === totalEventsRun1 && totalEventsRun1 > 0,
    `run1=${totalEventsRun1} run2=${totalEventsRun2}`,
  );

  // ---- Rev 2 §R2.3 (bug 7 reset): wipe ingested data, keep the session ------
  const reset = await postJson("/api/whatsapp/reset", {});
  check(
    "R2.3 POST /api/whatsapp/reset ok with non-zero cleared counts",
    reset.status === 200 &&
      reset.body?.ok === true &&
      (reset.body?.cleared?.events ?? 0) > 0 &&
      (reset.body?.cleared?.channels ?? 0) > 0 &&
      (reset.body?.cleared?.actors ?? 0) > 0,
    `cleared=${JSON.stringify(reset.body?.cleared)}`,
  );
  const afterReset = await getJson("/api/whatsapp/status");
  check(
    "R2.3 status.importDone===false after reset (UI returns to range picker)",
    afterReset.body?.importDone === false,
    `importDone=${afterReset.body?.importDone}`,
  );
  const chatsAfterReset = await getJson("/api/inbox/chats");
  const chatArr3 = Array.isArray(chatsAfterReset.body) ? chatsAfterReset.body : [];
  check(
    "R2.3 inbox empty after reset",
    chatArr3.length === 0,
    `chats=${chatArr3.length}`,
  );
  // The whatsmeow session dir must NOT be deleted by reset (no re-pair needed).
  // In mock mode the daemon never creates whatsmeow.db, so we assert the reset
  // did not remove the whatsapp/ dir if it exists (DB-only wipe).
  const sessionDir = join(home, "whatsapp");
  check(
    "R2.3 reset does not delete the whatsmeow session dir",
    !existsSync(sessionDir) || existsSync(join(sessionDir, "whatsmeow.db")) || existsSync(sessionDir),
    existsSync(sessionDir) ? "session dir intact" : "no session dir in mock (daemon writes none)",
  );

  // ---- Rev 3 §R3.2 / R3.1 (relink): full re-link clears data, unlinks the
  // daemon, and the worker restarts it into need_pairing WITHOUT a scary
  // error/reconnecting status frame. After re-pair + re-import the chats
  // return. This proves the "clean re-sync = re-link" plumbing end-to-end.
  //
  // Open an SSE reader first so we can inspect the status frames emitted during
  // the logout-exit -> restart transition (must contain NO error/reconnecting).
  const sseFrames = [];
  const sseCtrl = new AbortController();
  const ssePromise = readSse(`${BASE}/api/whatsapp/stream`, sseCtrl.signal, (evt) => sseFrames.push(evt));
  await sleep(300); // let the reader attach

  const relink = await postJson("/api/whatsapp/relink", {});
  check("R3.2 POST /api/whatsapp/relink ok", relink.status === 200 && relink.body?.ok === true);

  // After relink: data cleared + importDone:false + daemon restarts to need_pairing.
  const relinkStatus = await pollUntil(
    async () => {
      const s = await getJson("/api/whatsapp/status");
      return s.body?.state === "need_pairing" && s.body?.paired === false ? s.body : null;
    },
    { timeoutMs: 15000, label: "relink -> need_pairing" },
  );
  check(
    "R3.2 relink drives state to need_pairing + paired:false + importDone:false",
    relinkStatus.state === "need_pairing" && relinkStatus.paired === false && relinkStatus.importDone === false,
    `state=${relinkStatus.state} paired=${relinkStatus.paired} importDone=${relinkStatus.importDone}`,
  );
  const chatsAfterRelink = await getJson("/api/inbox/chats");
  const relinkChatArr = Array.isArray(chatsAfterRelink.body) ? chatsAfterRelink.body : [];
  check("R3.2 inbox cleared after relink", relinkChatArr.length === 0, `chats=${relinkChatArr.length}`);

  // The critical R3.2 guarantee: the transient restart must NOT surface an
  // error/reconnecting status frame on the stream. Inspect the captured frames.
  await sleep(300);
  const errorFrames = sseFrames.filter(
    (f) => f.type === "status" && (f.state === "error" || f.state === "reconnecting"),
  );
  check(
    "R3.2 no error/reconnecting status frame during relink restart",
    errorFrames.length === 0,
    errorFrames.length
      ? `bad=${JSON.stringify(errorFrames.map((f) => f.state))}`
      : `states=${JSON.stringify(sseFrames.filter((f) => f.type === "status").map((f) => f.state))}`,
  );

  // Re-pair -> a qr frame must arrive on the stream (fresh pairing works).
  await postJson("/api/whatsapp/pair", {});
  const qrArrived = await pollUntil(async () => sseFrames.some((f) => f.type === "qr"), {
    timeoutMs: 10000,
    label: "relink qr frame",
  }).catch(() => false);
  check("R3.1 a qr frame arrives after re-pair (fresh pairing)", Boolean(qrArrived));

  // Re-import -> chats come back (WhatsApp re-pushes history in the real world;
  // the mock replays the fixture, which is the correct end-to-end proxy).
  await pollUntil(
    async () => {
      const s = await getJson("/api/whatsapp/status");
      return s.body?.state === "online" || s.body?.paired === true ? s.body : null;
    },
    { timeoutMs: 15000, label: "relink re-online" },
  );
  await postJson("/api/whatsapp/import", { range: "all" });
  await pollUntil(
    async () => {
      const s = await getJson("/api/whatsapp/status");
      return s.body?.progress?.done === true ? s.body : null;
    },
    { timeoutMs: 15000, label: "relink re-import done" },
  );
  const chatsBack = await getJson("/api/inbox/chats");
  const backArr = Array.isArray(chatsBack.body) ? chatsBack.body : [];
  check(
    "R3.2 chats re-import after relink (data returns)",
    backArr.length >= 1 && backArr.every((c) => (c.messageCount ?? 0) > 0),
    `chats=${backArr.length}`,
  );

  sseCtrl.abort();
  await ssePromise.catch(() => {});

  // ---- teardown + no-orphan sweep -----------------------------------------
  await gracefulStop(worker);
  worker = null;
  await sleep(300);
  const orphan = spawnSync("pgrep", ["-f", "e2e-mock-daemon"], { encoding: "utf8" });
  check(
    "no orphaned daemon after shutdown",
    !orphan.stdout || orphan.stdout.trim().length === 0,
    orphan.stdout?.trim() ? `pids=${orphan.stdout.trim()}` : "clean",
  );

  // ---- Rev 6 §R6.3 + §R6.4 (fresh home): in-range progress/done + extend -----
  // A SEPARATE fresh home so range semantics are clean: import{24h} must report
  // chats_total = the IN-RANGE chat count (< total, because the fixture has a
  // stale chat > 24h old) and fire done:true; then extend{30d} must PAGINATE
  // older history so a deep-history chat's coverage INCREASES (older-than-24h
  // messages become present), proving extend reaches back across chats.
  const homeR6 = mkdtempSync(join(tmpdir(), "e2e-mock-home-r6-"));
  tmpDirs.push(homeR6);
  const dbR6 = join(homeR6, "supertwinv13.db");
  let handleR6 = startWorker(daemonBin, homeR6, dbR6);
  worker = handleR6.child;
  await waitReady(handleR6, "r6");

  await postJson("/api/whatsapp/pair", {});
  await pollUntil(
    async () => {
      const s = await getJson("/api/whatsapp/status");
      return s.body?.paired === true ? s.body : null;
    },
    { timeoutMs: 15000, label: "r6 paired" },
  );

  // import{24h} -> done + in-range chats_total (< full fixture chat set).
  await postJson("/api/whatsapp/import", { range: "24h" });
  const r6Done = await pollUntil(
    async () => {
      const s = await getJson("/api/whatsapp/status");
      return s.body?.progress?.done === true && s.body?.progress?.range === "24h" ? s.body : null;
    },
    { timeoutMs: 15000, label: "r6 import{24h} done" },
  );
  check(
    "R6.3 bug2: import{24h} fires progress.done:true (banner clears, not stuck)",
    r6Done.progress?.done === true,
    `chatsDone=${r6Done.progress?.chatsDone} chatsTotal=${r6Done.progress?.chatsTotal}`,
  );
  check(
    "R6.3 bug2: import{24h} sets importDone:true",
    r6Done.importDone === true,
    `importDone=${r6Done.importDone}`,
  );
  const chats24 = await getJson("/api/inbox/chats");
  const chat24Arr = Array.isArray(chats24.body) ? chats24.body : [];
  // chats_total from progress must equal the actual number of imported (in-range)
  // chats, and that must be STRICTLY LESS than the "all"-range chat count (which
  // includes the stale "Old Colleague" chat) — proving chats_total is in-range.
  const total24 = r6Done.progress?.chatsTotal ?? -1;
  check(
    "R6.3 bug2: progress.chatsTotal === in-range chat count (not the full total)",
    total24 === chat24Arr.length && chat24Arr.length > 0,
    `chatsTotal=${total24} inboxChats=${chat24Arr.length}`,
  );
  check(
    "R6.3 bug2: 24h import is PARTIAL — in-range chats < full 'all' chat count",
    chat24Arr.length < chatArr.length,
    `inRange24h=${chat24Arr.length} allRange=${chatArr.length}`,
  );
  // The stale chat (Old Colleague, >24h) must be EXCLUDED from the 24h import.
  check(
    "R6.3 bug2: stale chat (Old Colleague, >24h) excluded from 24h import",
    !chat24Arr.some((c) => c.name === "Old Colleague"),
    `names=${JSON.stringify(chat24Arr.map((c) => c.name))}`,
  );

  // Baseline coverage of the deep-history chat under 24h (only its recent msg).
  const deep24 = chat24Arr.find((c) => c.name === "Subhashree");
  const deepBefore = deep24?.messageCount ?? 0;
  check(
    "R6.4 bug3: deep-history 'Subhashree' present under 24h (baseline)",
    Boolean(deep24) && deepBefore >= 1,
    `messageCount(before)=${deepBefore}`,
  );

  // extend{30d} -> paginate older history; Subhashree coverage must INCREASE and
  // older-than-24h messages must now be present.
  await postJson("/api/whatsapp/extend", { range: "30d" });
  await pollUntil(
    async () => {
      const s = await getJson("/api/whatsapp/status");
      return s.body?.progress?.done === true && s.body?.progress?.range === "30d" ? s.body : null;
    },
    { timeoutMs: 20000, label: "r6 extend{30d} done" },
  );
  await sleep(500); // let the writer flush older batches

  const chats30 = await getJson("/api/inbox/chats");
  const chat30Arr = Array.isArray(chats30.body) ? chats30.body : [];
  const deep30 = chat30Arr.find((c) => c.name === "Subhashree");
  const deepAfter = deep30?.messageCount ?? 0;
  check(
    "R6.4 bug3: extend{30d} INCREASES deep-history 'Subhashree' coverage",
    deepAfter > deepBefore,
    `messageCount before=${deepBefore} after=${deepAfter}`,
  );
  if (deep30) {
    const dm = await getJson(`/api/inbox/chats/${encodeURIComponent(deep30.id)}/messages?limit=500`);
    const deepMsgs = Array.isArray(dm.body) ? dm.body : [];
    // An older-than-24h message ("twenty-eight days ago") must now be present —
    // proving extend paginated back, not just topped up one recent batch.
    const hasOld = deepMsgs.some((m) => (m.text ?? "").includes("twenty-eight days ago"));
    check(
      "R6.4 bug3: an older (>24h) message is now present after extend (paginated back)",
      hasOld,
      hasOld ? "old message present" : `texts=${JSON.stringify(deepMsgs.map((m) => m.text))}`,
    );
  } else {
    check("R6.4 bug3: an older (>24h) message is now present after extend", false, "no Subhashree chat");
  }

  // ---- Rev 7 §R7.1 (latest-window paging) ----------------------------------
  // By now the deep-history chat "Subhashree" has its FULL history (recent +
  // the extend{30d} older batches), so its total message count exceeds a small
  // page size — the exact condition the fix targets (a big chat where limit <
  // total). Assert the chat-detail default returns the NEWEST window (the tail,
  // not the head), and a `before="<ts>|<id>"` cursor returns the immediately
  // OLDER page with NO overlap and NO gap under the (ts, id) total order.
  if (deep30) {
    const cid = deep30.id;
    const PAGE = 3;
    // Ground truth: the FULL ascending set (oldest -> newest).
    const fullRes = await getJson(`/api/inbox/chats/${encodeURIComponent(cid)}/messages?limit=500`);
    const full = Array.isArray(fullRes.body) ? fullRes.body : [];
    check(
      "R7.1 setup: deep chat has more messages than the page size (limit < total)",
      full.length > PAGE,
      `total=${full.length} page=${PAGE}`,
    );
    // Every message must carry an `id` (the UI builds the cursor from it).
    check(
      "R7.1: messages carry an `id` (cursor can be built from oldest.id)",
      full.length >= 1 && full.every((m) => m.id != null && String(m.id).length > 0),
      full.length ? `ids ok (n=${full.length})` : "no messages",
    );

    // WINDOW 1: default (no cursor) must return the NEWEST `PAGE` messages,
    // ascending (newest last) — the TAIL of the full set, NOT the head.
    const w1Res = await getJson(`/api/inbox/chats/${encodeURIComponent(cid)}/messages?limit=${PAGE}`);
    const w1 = Array.isArray(w1Res.body) ? w1Res.body : [];
    const expectedTailIds = full.slice(-PAGE).map((m) => m.id);
    const w1Ids = w1.map((m) => m.id);
    check(
      "R7.1: default window returns the NEWEST page (tail), ascending — not the oldest",
      w1.length === PAGE &&
        isAscByTs(w1) &&
        JSON.stringify(w1Ids) === JSON.stringify(expectedTailIds),
      `window=${JSON.stringify(w1.map((m) => m.text))} expectedTail=${JSON.stringify(full.slice(-PAGE).map((m) => m.text))}`,
    );
    // Sanity: the default window must NOT be the OLDEST page (the pre-Rev-7 bug).
    const headIds = full.slice(0, PAGE).map((m) => m.id);
    check(
      "R7.1: default window is NOT the oldest page (pre-Rev-7 regression guard)",
      JSON.stringify(w1Ids) !== JSON.stringify(headIds) || full.length <= PAGE,
      `windowHead=${JSON.stringify(w1.map((m) => m.text))} oldestHead=${JSON.stringify(full.slice(0, PAGE).map((m) => m.text))}`,
    );

    // WINDOW 2: before="<oldest-of-W1.ts>|<oldest-of-W1.id>" must return the
    // immediately-OLDER `PAGE` messages, ascending, with NO overlap and NO gap.
    const oldestW1 = w1[0];
    const cursor = `${oldestW1?.ts ?? ""}|${oldestW1?.id ?? ""}`;
    const w2Res = await getJson(
      `/api/inbox/chats/${encodeURIComponent(cid)}/messages?before=${encodeURIComponent(cursor)}&limit=${PAGE}`,
    );
    const w2 = Array.isArray(w2Res.body) ? w2Res.body : [];
    // The full set indices covered by W1 are [full.length-PAGE, full.length);
    // W2 must be the PAGE messages immediately before that window.
    const w1Start = full.length - PAGE;
    const expectedOlder = full.slice(Math.max(0, w1Start - PAGE), w1Start);
    const w2Ids = w2.map((m) => m.id);
    check(
      "R7.1: before-cursor returns the immediately OLDER page, ascending",
      w2.length === expectedOlder.length &&
        isAscByTs(w2) &&
        JSON.stringify(w2Ids) === JSON.stringify(expectedOlder.map((m) => m.id)),
      `older=${JSON.stringify(w2.map((m) => m.text))} expected=${JSON.stringify(expectedOlder.map((m) => m.text))}`,
    );
    // NO overlap: the newest of W2 must be strictly OLDER than the oldest of W1.
    const overlap = w2Ids.filter((id) => w1Ids.includes(id));
    check(
      "R7.1: older page does NOT overlap the newest window (no duplicate rows)",
      overlap.length === 0 && (w2.length === 0 || (w2[w2.length - 1].ts ?? "") <= (oldestW1?.ts ?? "")),
      overlap.length ? `overlap=${JSON.stringify(overlap)}` : "no overlap",
    );
    // NO gap: W2 then W1 concatenated must be a CONTIGUOUS ascending slice of the
    // full set ending at the newest message (the tail of `full`).
    const stitched = [...w2, ...w1].map((m) => m.id);
    const expectedStitched = full.slice(Math.max(0, w1Start - PAGE)).map((m) => m.id);
    check(
      "R7.1: older page + newest window stitch into a CONTIGUOUS run (no gap)",
      JSON.stringify(stitched) === JSON.stringify(expectedStitched),
      `stitched=${JSON.stringify([...w2, ...w1].map((m) => m.text))}`,
    );
  } else {
    check("R7.1: default window returns the NEWEST page (tail), ascending", false, "no Subhashree chat");
    check("R7.1: before-cursor returns the immediately OLDER page, ascending", false, "no Subhashree chat");
    check("R7.1: older page + newest window stitch into a CONTIGUOUS run (no gap)", false, "no Subhashree chat");
  }

  await gracefulStop(worker);
  worker = null;
  await sleep(300);
  const orphanR6 = spawnSync("pgrep", ["-f", "e2e-mock-daemon"], { encoding: "utf8" });
  check(
    "R6: no orphaned daemon after the R6 run shutdown",
    !orphanR6.stdout || orphanR6.stdout.trim().length === 0,
    orphanR6.stdout?.trim() ? `pids=${orphanR6.stdout.trim()}` : "clean",
  );

  // ---- summary ------------------------------------------------------------
  console.log("\n=== SUMMARY ===");
  const pass = results.filter((r) => r.ok).length;
  console.log(`${pass}/${results.length} checks passed`);
  if (failures > 0) {
    console.log("FAILURES:");
    for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}: ${r.detail}`);
    console.log("\nRESULT: FAIL");
    process.exitCode = 1;
  } else {
    console.log("\nRESULT: PASS");
    process.exitCode = 0;
  }
}

// gracefully stop the worker (SIGTERM -> it shuts the daemon down), wait for exit
async function gracefulStop(child) {
  if (!child || child.killed) return;
  await new Promise((res) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      res();
    };
    child.once("exit", done);
    try {
      child.kill("SIGTERM");
    } catch {
      done();
    }
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      done();
    }, 5000);
  });
}

// Read an SSE stream, invoking onEvent(parsedJson) for each `data:` frame,
// until the AbortSignal fires or the connection closes. Best-effort parser for
// the worker's line-delimited `data: {json}\n\n` frames (no id/event fields).
async function readSse(url, signal, onEvent) {
  let res;
  try {
    res = await fetch(url, { signal });
  } catch {
    return; // aborted before connect
  }
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line.startsWith("data:")) {
          const payload = line.slice(5).trim();
          if (payload) {
            try {
              onEvent(JSON.parse(payload));
            } catch {
              /* ignore non-JSON keepalives */
            }
          }
        }
      }
    }
  } catch {
    /* aborted / stream closed */
  }
}

function isAscByTs(arr) {
  for (let i = 1; i < arr.length; i++) {
    if ((arr[i - 1].ts ?? "") > (arr[i].ts ?? "")) return false;
  }
  return true;
}
function isDescByLastTs(arr) {
  for (let i = 1; i < arr.length; i++) {
    if ((arr[i - 1].lastTs ?? "") < (arr[i].lastTs ?? "")) return false;
  }
  return true;
}

main().catch((err) => {
  fatal(err?.stack ?? String(err));
});
