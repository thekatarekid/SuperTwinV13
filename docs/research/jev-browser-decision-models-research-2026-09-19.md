# Jev, browser automation, and decision models for SuperTwin

Research date: 19 September 2026. This is an architectural assessment and proposed evaluation plan, not an implemented integration or a measured SuperTwin benchmark.

**Recommendation: pilot Jev as a semantic decision service inside the existing pipeline.** The best initial candidates are evidence verification, matching new evidence to existing spaces, and selecting bounded browser actions. Keep generation, exact computation, permissions, and durable writes in their existing owners. Browser automation can expand capture coverage, but reliable recurring capture requires site adapters, provenance, and recovery; cheap inference alone does not provide those.

All external research used the Codex in-app browser, as requested. No external browser-harness was used to access links. The review covered the launch article, all main documentation guides, primitives, patterns and cookbooks, relevant JavaScript and Python SDK/API references, all ten supplied posts, the four supplied repositories, and the memory implementation linked by its author. Repository review focused on the architecture, documented execution paths, selected implementation files, and benchmark methodology; it was not an exhaustive audit of every file. No Jev requests or live-account extraction tests were run.

**What Jev actually does**

Jev receives text or JSON state and typed questions. It returns choices, probability distributions, or scores without generating an arbitrary answer string. TypeSafe describes training through reinforcement learning for calibrated decisions. This makes it useful when software already knows the possible actions or can construct candidates from observed data. The candidates can change on every request: today's space IDs, the current page's element IDs, or the evidence spans in this message. They need not be a permanently fixed taxonomy. [Launch article](https://typesafe.ai/blog/introducing-system-one-models-and-jev), [System One concepts](https://docs.typesafe.ai/concepts/system-one).

| Primitive | Meaning | SuperTwin example |
|---|---|---|
| Choice | One option from up to 255; relative probabilities across the supplied alternatives | Which of these existing spaces best fits this episode, including “none”? |
| Noul | Probability of a yes/no proposition | Does this specific passage establish that the user committed to this task? |
| Score | Distribution and expected position across 2–10 described, ordered levels | Is this suggestion irrelevant, loosely related, useful, or immediately actionable? |

A Score of 1.3 is an expected position on the supplied scale, not a price, count, date, or independently meaningful numerical measurement. Choice always has a best option even when every option is bad. Include an escape option and assess absolute suitability. For multiple valid spaces, use independent candidate-fit questions rather than forcing a single mutually exclusive choice. [Choice](https://docs.typesafe.ai/primitives/choice), [Noul](https://docs.typesafe.ai/primitives/noul), [Score](https://docs.typesafe.ai/primitives/score).

Questions in one request run independently against the same state. They do not consume one another's answers. We can ask about several possible actions in parallel and use only the answer associated with the selected action; an actual dependency requires another request. Question identifiers are application bookkeeping, so put the event, field, or candidate being judged into the question instructions explicitly. [Advanced primitives](https://docs.typesafe.ai/primitives/advanced), [Fan-out](https://docs.typesafe.ai/patterns/fan-out).

The current documented model is `jev-1.13.0`: text-only, 64k total input, with a separate 32k bound on state plus the longest individual question. It has no customer fine-tuning or automatic learning from our traffic. Personalization requires supplied preferences/history or a separate model trained on outcomes. English is its strongest language; our Hinglish and multilingual conversations need evaluation. Pin a model version rather than relying on a moving alias. [Models](https://docs.typesafe.ai/models).

The output schema guarantee is valuable, but a valid action can still be the wrong action. Confidence describes the model's distribution; a threshold of 0.9 is not established as 90% correctness on our tasks. TypeSafe explicitly documents problems with arithmetic, dates, negation, irrelevant context, multi-step reasoning, and adversarial input. Its own documentation therefore supports a narrower interpretation than “cannot hallucinate.” [Confidence](https://docs.typesafe.ai/confidence), [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13).

**Where it can help our system**

| Area | Proposed Jev responsibility | What still owns the rest | Priority |
|---|---|---|---|
| Grounding / Critic | Judge whether evidence supports a proposed claim, actor, task, or space association | Code checks exact quote/ID validity; existing model handles ambiguous reasoning and explanations | First pilot |
| Existing-space assignment | Rerank retrieved candidate spaces; judge absolute fit and duplicate association | Local retrieval proposes candidates; code preserves provenance and applies the result | First pilot |
| Task detection | Classify candidate evidence as commitment, request, suggestion, cancellation, completion, or irrelevant | Context assembly, evidence-span construction, free-form task text and plans | Early, with recall measurement |
| Typed extraction | Choose the relevant amount, date mention, order ID, person, or URL from enumerated candidates | Parsers find/copy candidates; code validates and computes exact values | Early |
| Tool / recipe selection | Choose a suitable existing tool or site recipe and judge whether it applies at all | Registry, permissions, arguments, execution, and recovery | Early |
| Browser micro-actions | Select an allowed operation and observed target | Browser transport, observation, freshness checks, writer fallback, completion proof | Bounded browser pilot |
| New-space proposals | Judge whether unmatched episodes form a coherent recurring goal; rank proposals and detect overlap | Clustering, summaries, naming, goal generation, existing approval UX | After matching works |
| Memory reconciliation | Same fact, additional detail, changed fact, unresolved conflict, wrong entity | Existing temporal claims store and deterministic write rules | Useful extension |
| Task suggestions | Score grounded candidate suggestions for relevance, novelty, intent, and readiness | Generator creates candidates; code ranks; no work is silently lost | After grounding works |
| Retrieval | Select retrieval mode, assess evidence relevance, or flag insufficient support | SQL, coverage index, graph walks, local embeddings/reranker | Selective; keep T0 local |
| Dynamic UI | Select an existing view/component and its emphasis | Renderer and data schemas; generator writes new prose when necessary | Opportunistic |
| Surface choice / presence | Later: semantic context features or preference prediction across devices | Current deterministic router and direct device activity signals | Low priority today |
| Job matching | Rank a user's fit to described requirements and identify missing evidence | Real job information, user constraints, explanations, actual outcome labels | Good ranking feature; not hiring probability |

These are proposed uses, not claims of demonstrated accuracy on our data.

**Space assignment and new spaces**

Our existing [Orient pass](/Users/adityakatare/Documents/SuperTwinV13/worker/src/brain/orient.ts) combines decisions with generation. Replacing the whole pass with Jev would lose episode summaries, proposed labels, goals, and questions. A better split is local candidate retrieval → Jev matching/verification → the existing writer. Batch related events so each call sees useful conversation context rather than an isolated sentence.

For example, a villa link plus “this fits the Goa dates” could be compared with the Goa trip, home search, and other retrieved spaces. Include people, time window, goal, and a little supporting evidence for each candidate. Ask separately whether any space fits; use independent fit judgments if an item can legitimately belong to multiple spaces. If retrieval misses the correct space, Jev cannot recover an option it never sees.

“No existing space fits” does not imply “create a new space.” Accumulate related unmatched episodes, retrieve possible duplicates again, test whether they express a coherent goal, and let a generative model propose the title and description. Existing source evidence and approval rules remain the basis for creation. The documented two-stage skill selection example is a useful analogue: broad shortlist, detailed rerank, then absolute-fit verification. Its own errors show why even that is not a guarantee. [Skill suggestion cookbook](https://docs.typesafe.ai/cookbooks/skill_suggestion).

**Tasks, fields, and execution**

Jev can help distinguish “I will send it,” “could someone send it?”, “I already sent it,” “don't send it,” and “if we book, send it.” Those distinctions require speaker identity, preceding messages, source time, and cancellation/completion context. It should not become a cheap discard gate that loses obligations whenever it is uncertain. Preserve uncertain candidates for the existing understanding path and measure missed tasks as carefully as false positives.

For extraction, construct candidate spans first. Regex and deterministic parsers can enumerate date strings, amounts, emails, phone numbers, order identifiers, or complete source sentences. Jev picks the relevant candidate and code copies its exact value. The model cannot select an omitted candidate or invent a missing task title. Relative dates must be resolved against the message's timestamp and timezone; old history must not become a new due task. Date arithmetic and invalid-date rejection belong in code. [Value extraction](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook), [Date extraction](https://docs.typesafe.ai/cookbooks/date_extraction_cookbook).

During execution, useful questions include whether a recipe applies, which observed field is relevant, whether the page is waiting/loading/blocked, and whether fresh evidence supports a claimed result. Code must verify the actual postcondition: an order row was extracted, a saved artifact exists, or the intended state changed. A model's `DONE` choice is not the proof.

The best initial semantic verifier is adjacent to our existing [Critic](/Users/adityakatare/Documents/SuperTwinV13/worker/src/brain/critic.ts:1). Preserve mechanical coverage and exact-evidence checks; let Jev answer the semantic questions that exact matching cannot. A literal quote can exist while failing to support the attributed person or conclusion. The TypeSafe extraction cascade and citation checker directly illustrate this distinction. [Extraction cascade](https://docs.typesafe.ai/cookbooks/sde_cascade), [Citation checking](https://docs.typesafe.ai/cookbooks/citation_check).

**Memory and retrieval**

The supplied memory post links to [atlas-jev](https://github.com/sidmanale643/atlas-jev). It uses a generative model to extract atomic memories, local embeddings and LanceDB to find neighbors, and Jev for worth/add/update/skip/conflict decisions and retrieval relevance. This is a useful division of labor, not a memory system made from Jev alone. Its example thresholds and small neighbor set are implementation choices, not validated universal settings. [Memory post](https://x.com/sidmanale643/status/2100983286793474398/photo/1).

We already have stronger domain-specific temporal requirements in [extract-pass.ts](/Users/adityakatare/Documents/SuperTwinV13/worker/src/brain/extract-pass.ts:1): exact evidence, typed-field validation, supersession without deletion, coexistence, and unknown subjects instead of guesses. Add semantic reconciliation to that store rather than replacing SQLite with the demo's database. “Lived in Berlin” and “now lives in Austin” may both be true at different times. Preserve time and provenance instead of overwriting a past truth. Conflicting evidence should remain retrievable.

For retrieval, Jev can judge whether a passage supports the question, contradicts an answer, or is merely topically related. A separate absolute-evidence check prevents selecting the least bad result as though it answered the query. Keep deterministic coverage accounting: a semantic model cannot know which unobserved months or sources are missing. [RAG passage classification](https://docs.typesafe.ai/cookbooks/classifying_rag_passages), [Semantic find](https://docs.typesafe.ai/cookbooks/semantic_find).

Do not insert a remote Jev request into every keystroke. We already have a [local cross-encoder reranker](/Users/adityakatare/Documents/SuperTwinV13/worker/src/retrieval/reranker.ts:1). Its marginal API cost is zero. Compare it against Jev only for a concrete weakness, such as personalized relevance or evidence sufficiency after the user submits a query. A small published reranking experiment is not grounds to replace our local retrieval stack. [Reranking cookbook](https://docs.typesafe.ai/cookbooks/rerank_typesafe).

**Presence, nudges, and dynamic UI**

The current [surface router](/Users/adityakatare/Documents/SuperTwinV13/worker/src/surfaces/router.ts:1) deliberately makes no model calls. It uses recent screen activity, deterministic ordering, settings, and durable artifact placement. That is already cheaper and more reliable than asking Jev whether the Mac was recently active. Keep it.

For future multi-device routing, collect direct permitted signals first: device heartbeat, foreground/idle status, last interaction, explicit channel preference, and prior opens/dismissals. A Mac going idle is not evidence that the phone is active. Jev could translate semantic context into features—travel context, meeting context, continuity with the current task—while a small outcome-trained model predicts which eligible destination will be useful. Until sufficient feedback exists, rules are the baseline. Preserve the product contract that the router chooses where, not whether, and that artifacts remain on their durable surfaces. [Product routing contract](/Users/adityakatare/Documents/SuperTwinV13/SuperTwinV13_Product_V6.md:1214).

The post labeled “Dynamic UI” is specifically about tool decisions on partial voice transcripts. It suggests useful speculation: “compare these villas…” can start read-only retrieval and prepare a comparison view before the utterance ends. Cancel or revise when the completed intent differs; don't execute consequential actions from incomplete speech. Jev can choose among existing table, checklist, timeline, map, and calendar components. It cannot generate arbitrary React or new UI copy. Avoid continual rearrangement under the user's pointer. [Voice/partial-intent post](https://x.com/BhosalePratim/status/2100986774742765991).

**Can it route tasks among free ChatGPT, Claude, Grok, and Gemini accounts?**

Technically yes, but the semantic router and access mechanism are separate problems. Jev could classify task properties, then score eligible model/service candidates. It does not grant API access to a consumer account, know current remaining quotas without telemetry, or establish which provider is best on our workload.

First filter in code for connected/allowed services, remaining availability, required modality and tools, context capacity, and data-sharing settings. Then estimate task success, latency, and resource use. Select a candidate using a utility function, with a known fallback. A statement such as “Claude is best for coding” is not a substitute for outcomes on our actual task distribution. Measure complete workflows, including browser interaction and retries, if the transport is a web UI.

[RouteLLM](https://github.com/lm-sys/RouteLLM) is a useful comparison: it trains routers on preference data and calibrates thresholds for quality/cost tradeoffs. Its historical benchmark models and scores do not transfer automatically to today's consumer services. Some configurations also use paid embeddings. A learned router predicts from past outcomes; Jev supplies a general semantic judgment from the current state. They can be combined, but neither solves consumer-service integration or quota management.

For our chosen architecture, the useful version is routing **inside** SuperTwin: deterministic/local operation, Jev decision, inexpensive generator, or stronger planner; and API, saved recipe, browser, or computer-use transport. The user's multi-provider consumer routing idea remains an exploratory alternative, not a recommended product direction.

**The browser stack and how the projects fit**

| Component | Actual role | Best lesson for us |
|---|---|---|
| Jev | Semantic decision model over text/JSON candidates | Cheap choices inside constrained loops |
| browser-use/jev-ultrafast | Small browser-agent demo with DOM observations, Jev action choices, and a text-writing fallback | Batch compatible action heads, validate target identity, reduce observation overhead |
| Tencent BrowserSkill | Chromium extension + local daemon + CLI for a logged-in browser and separate Agent Window | Optional transport for the user's existing browser; session ownership and cleanup |
| awlevin/typesafe-computer-use | macOS perception/action pipeline using local OCR and Accessibility before Jev | Reuse local perception; account for OCR/action latency, not only model latency |
| Compos | Shared application state and semantic commands for people and agents | Give agents stable state and operations instead of making them scrape our own UI |

The components are compatible as ideas, but the repositories are not plug-and-play layers that can all be stacked unchanged.

The current [jev-ultrafast repository](https://github.com/browser-use/jev-ultrafast) itself depends on Browser Harness. It is not simply a replacement model provider for our existing code or for every browser-use integration. We can port its decision pattern onto our transport without adopting that dependency. It selects operations such as CLICK, TYPE_TEXT, SELECT, SCROLL, WAIT, DONE, and BLOCKED, plus compatible targets. A separate generative helper supplies free-form text when needed. Model output is not an arbitrary selector or script.

Its best engineering idea is preserving the connection between an observed element and the action: validate current document, target identity, field context, geometry, and occlusion before acting. Its minimal observer has gaps around frames, shadow DOM, canvas, uploads, popups, and more complex interactions. The impressive flight demo is therefore evidence for a pattern, not a universal site-coverage benchmark. [Repository](https://github.com/browser-use/jev-ultrafast), [Performance methodology](https://github.com/browser-use/jev-ultrafast/blob/main/docs/performance.md).

Tencent's [BrowserSkill](https://github.com/Tencent/BrowserSkill) controls Chrome/Edge through an extension and local daemon. It supports structured observations, element references, normal browser operations, frames and shadow DOM, and explicit borrowing/returning of user tabs. It shares a logged-in profile while using a separate Agent Window. Session cleanup and the user's borrowing settings are part of the product behavior. It is not an Amazon/Instagram/Airbnb extractor or a decision model.

Its current extension manifest requires Chrome 125 or newer and includes `debugger`, `scripting`, and broad host permissions. This is a real integration and permission surface. The natural SuperTwin role is an optional connector to a user's existing Chrome/Edge profile. Installation inside our dedicated Chrome-for-Testing profile appears technically plausible but is untested; loading extensions into the Tauri webview is a different matter. Do not let two controllers race on the same tab. [Extension configuration](https://github.com/Tencent/BrowserSkill/blob/main/apps/extension/wxt.config.ts), [Session/action contract](https://github.com/Tencent/BrowserSkill/blob/main/skill/SKILL.md).

**What our existing browser already provides, and what is missing**

Our [Chromium launcher](/Users/adityakatare/Documents/SuperTwinV13/worker/src/browser/chromium.ts:1) already uses a separate persistent Chrome-for-Testing profile. It does not automatically share the user's everyday Chrome logins. It communicates through a CDP pipe, not an exposed CDP WebSocket URL. A library expecting a WebSocket cannot just be pointed at that pipe; implement a transport adapter or keep our controller.

Our [browser implementation](/Users/adityakatare/Documents/SuperTwinV13/worker/src/browser/harness.ts:264) already has AX observations, stable element references, agent tabs, pacing, and click/type actions. That is a useful foundation for a Jev policy. Candidate filtering is necessary because a page can expose more than 255 nodes. Include a snapshot/document version in each decision and reobserve when it becomes stale.

Two concrete gaps matter before allowing broader unattended workflows. The generic [browser_click tool](/Users/adityakatare/Documents/SuperTwinV13/worker/src/browser/tools.ts:87) is labeled safe, although a click's effect can be buy, send, delete, or merely navigate. We need workflow/effect authorization and action filtering, not confidence as permission. The click implementation also needs stronger target/occlusion/geometry validation; its missing-box fallback must not become an accidental click at a default coordinate. These are scoped observations from reading the path, not a complete safety audit.

Our [captured-request replay](/Users/adityakatare/Documents/SuperTwinV13/worker/src/browser/harness.ts:427) currently matches a URL and performs an in-page GET with credentials. It does not preserve arbitrary original methods, bodies, or headers. It is not a general GraphQL/POST discovery and replay engine. Prefer extracting responses already delivered during permitted navigation. Any reusable request adapter needs an explicit known read operation, validated parameters and response schema, bounded pagination, and status checks; do not blindly replay arbitrary traffic or move cookies into a remote service.

**Can this collect data from Amazon, Instagram, Airbnb, and other sites without a suitable API?**

Yes, for content available to the user's authorized browser session. It does not guarantee complete account history or perpetual unattended access. A site may expose useful data through rendered DOM, accessibility, or page responses, but login challenges, virtualization, dynamic schemas, missing media transcripts, and incomplete page loading still limit coverage.

Start with passive capture of content the user is already viewing. Then add narrowly scoped, user-enabled history/sync workflows. Prefer available exports or appropriate official APIs where they cover the requirement. Active browsing should run in owned agent tabs and stop cleanly on authentication/challenge boundaries or unknown side effects.

| Site | Useful bounded extraction | Example benefit | Main limitation |
|---|---|---|---|
| Amazon | Visible order IDs, items, dates, delivery status, tracking and return-window evidence | Link purchases to a trip/home project; surface a grounded delivery or return task | Multi-page variants, account challenges, changing markup; avoid collecting unrelated payment details |
| Airbnb | Viewed listings, saved options, trip/reservation details, displayed prices and conditions | Villa comparison, trip-space enrichment, preparation checklist | Dates, guest counts and price variants must remain attached; availability and price are time-specific |
| Instagram | User-enabled saved posts, captions, profile metadata and links available in the session | File saved cafés, travel ideas, creators, or products into relevant spaces | Virtualized lists and media-heavy content; Jev cannot understand a reel's pixels/audio by itself |

Illustrative workflow: the user enables trip research capture and browses villas → local extraction produces property fields plus source URL/time/evidence → Jev matches the item to the Goa space → a generator updates a comparison if needed → code stores the artifact → the current router presents it. A later recurring check should reuse a validated extractor rather than perform a fresh model-planned browsing session for every property.

For every extractor, store source/account identity, source URL, capture time, source time when known, entity key, exact evidence, adapter version, and coverage/cursor status. Deduplicate by stable source keys and preserve changes as revisions. “Captured 15 saved posts” must not become “all saved posts.” Feed outputs through the existing [consent admission path](/Users/adityakatare/Documents/SuperTwinV13/worker/src/db/consent-gate.ts:123); archive-only data must not be sent to a model. Tag agent-created changes so our own browsing does not trigger a feedback loop of new inferred user intent.

The preferred recurring pattern is **explore → build extractor → validate → replay → detect drift → repair**. Exploration may use an LLM and Jev. Routine extraction should be ordinary code wherever stable enough. Repair should run in a bounded test context and compare output quality before promotion. This is the valuable idea in the Compos follow-up post; its “virtually undetectable” claim is not a reliability guarantee. [Reusable-extractor post](https://x.com/_svs_/status/2100480761044623606).

**Computer use: what Jev contributes and what it does not**

[typesafe-computer-use](https://github.com/awlevin/typesafe-computer-use) turns local Apple Vision OCR and Accessibility information into numbered candidate targets, lets Jev choose an action, and executes through deterministic macOS code. It uses generative fallbacks for free text and richer final answers. The text-only decision loop therefore does not eliminate all generative or visual processing.

The useful optimizations for our screen pipeline are cropping to relevant windows, reusing OCR for unchanged regions, limiting Accessibility traversal, and keeping observation/action time visible in traces. The repository reports roughly 1.5-second complete steps versus 5.5 seconds for its comparison, even though the model-only improvement is much larger. OCR and action overhead matter. Missing AX labels, icon-only controls, canvas, and terminal content still require other perception paths. Foreground cursor automation also competes with the user; keep browser tasks in background browser controls where possible. [Implementation and measurements](https://github.com/awlevin/typesafe-computer-use), [Author thread](https://x.com/awlevin/status/2100262612428894676).

The [Milind thread](https://x.com/milindlabs/status/2100631847155994852) describes local CoreML element segmentation and OCR, followed by text-only Jev decisions, with a reported 90 ms decision time. No reproducible implementation was linked in the thread reviewed. It suggests an architecture to investigate, not a validated replacement for our screenwatch. “No pixels leave the Mac” still permits private text to leave in the Jev request.

**What to learn from Compos**

[Compos](https://github.com/svs/compos) gives people and agents access to the same durable application state and named commands. Its strongest lesson for SuperTwin is to expose operations such as `space.attachEvidence`, `task.prepare`, or `artifact.open` with typed arguments and explicit effects, and have both the UI and agent call those operations. An agent should not need OCR to operate our own app.

Stable object references, mutation provenance, supervised background jobs, and end-to-end traces also transfer well. Its architecture is not a reason to rewrite our TypeScript/Tauri stack in Elixir/Scheme. [Architecture](https://github.com/svs/compos/blob/main/docs/ARCHITECTURE.md), [Design essay](https://github.com/svs/compos/blob/main/docs/EMACS-AS-AGENT-HARNESS.md).

The accompanying tweet's “no CDP” description needs qualification: the current extension README describes content-script reads and on-demand `chrome.debugger` CDP for trusted typing/clicking. Avoiding a remote-debugging launch flag is different from never using CDP. BrowserSkill also explicitly uses debugger permissions. A normal local profile does not prove automation cannot be detected. Compos is GPL-3.0; the reviewed browser/desktop demos and BrowserSkill declare MIT. Borrow architectural ideas freely; evaluate the actual license obligations before copying implementation into our distribution. [Compos extension](https://github.com/svs/compos/tree/main/extension), [Original post](https://x.com/_svs_/status/2100201931197362521).

**Economics: cheap, but not free inference**

Jev's current published price is **$0.042 per million input tokens, with zero output-token charges**. State, question instructions, and candidate descriptions contribute to input. It is an inference service charged on input, not zero-cost inference. Batching questions saves repeating shared state, but extra questions still consume input. [Current model pricing](https://docs.typesafe.ai/models), [Parallel questions](https://docs.typesafe.ai/cookbooks/parallel_questions).

| Assumed total input per request | Jev per request | Jev per 1,000 requests |
|---|---:|---:|
| 2,000 tokens | $0.000084 | $0.084 |
| 5,000 tokens | $0.000210 | $0.210 |
| 10,000 tokens | $0.000420 | $0.420 |
| 32,000 tokens | $0.001344 | $1.344 |

Twenty 5k-token decisions cost about $0.0042 in Jev input charges. Conversely, a 2k-token call every five seconds for eight hours per day costs about $14.52 per user over 30 days. Changes, batching, caching, and event triggers still matter.

As checked on the research date, DeepSeek Flash's official pricing is $0.15/M uncached input off-peak and $0.30/M peak; cached input is $0.003/M and $0.006/M respectively. Output is $0.60/M or $1.20/M. Thus Jev is cheaper than uncached Flash input but more expensive than cached Flash input. Actual totals depend on cache hit rate and generated output. These prices can change. [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing).

An illustrative 1,000 requests at 2k input plus 100 generated output tokens each would cost $0.36–$0.72 on uncached Flash versus $0.084 for Jev decisions. With fully cached input, Flash would cost $0.066–$0.132. This is a billing illustration, not a claim that the models provide equivalent capabilities or quality. If we pay a flat CLI subscription for the existing path, Jev can reduce latency and quota pressure while still adding cash spend rather than lowering the subscription bill.

Adding a Jev pass in front of an unchanged generative call adds cost. Savings require that its decision eliminates a call, reduces a later context, avoids a repair, or substitutes for an existing judgment. If Orient still needs to generate the same summaries, a new space classifier does not automatically remove Orient's cost. Evaluate the whole pipeline, including any quality improvement from an additional verifier.

The browser flight trace reports 90,558 Jev input tokens and a small text-helper charge: approximately $0.003866 combined, consistent with the tweet's $0.0039. Its 7.073-second run starts after initial observation and ends at accepted DONE; it excludes setup, initial navigation, and independent completion verification. There were 17 Jev calls. These are source-reported results for a narrow workflow, not our measurements or a general browsing SLA. [Performance trace](https://github.com/browser-use/jev-ultrafast/blob/main/docs/performance.md), [Flight tweet](https://x.com/gregpr07/status/2100411066966749359).

**How I would integrate a pilot**

Keep a small worker-side decision adapter with a pinned model, typed questions, input minimization, explicit cancellation, a total wall-clock deadline, bounded retries, and existing accounting. Do not expose a TypeSafe key in the React renderer or page context. Current SDK defaults include per-attempt timeouts and retries, so use a total deadline for interactive work rather than assuming an individual timeout bounds the whole operation. Debug request/response bodies are not automatically redacted. [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript), [Client configuration](https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig), [Request options](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RequestOptions).

Illustrative request shape, not installed or executed:

```ts
import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";

const client = new TypeSafeClient({
  apiKey: process.env.TYPESAFE_API_KEY,
  defaultModel: "jev-1.13.0",
});

// Production state must already pass source and model-processing permissions.
const result = await client.systemOne({
  state: {
    event: { id: "e42", text: "This villa fits our Goa dates." },
    spaces: [
      { id: "goa", goal: "Plan the group's Goa trip" },
      { id: "home", goal: "Find a long-term home" },
    ],
  },
  questions: {
    primarySpace: choice(
      "Which listed space best matches event e42? Choose none if neither fits.",
      { goa: "Goa group trip", home: "Long-term home search", none: "No fit" },
    ),
    goaFits: noul(
      "Does event e42 provide evidence relevant to the Goa group-trip goal?",
    ),
    homeFits: noul(
      "Does event e42 provide evidence relevant to the long-term home-search goal?",
    ),
  },
}, { signal: AbortSignal.timeout(1500), retry: { maxRetries: 0 } });

// Only a candidate decision. Domain validation and existing writers apply it.
const proposedSpace = result.answers.primarySpace.choice;
```

The 1.5-second deadline above is illustrative and needs measurement from our deployment region. A real event requires source time, speaker and enough surrounding context. Questions about the same state can be batched, but don't merge unrelated private data simply to reduce request count. Log model/policy versions, input token usage, fallback reason, latency, candidate IDs, and outcome; avoid raw personal text in routine debug logs. Cache only with state, candidate-set, question and model-version invalidation.

The documentation currently lists 1,200 requests per minute and 250,000 tokens per second, subject to change; check the actual account limits before deployment. A shared service needs backpressure and per-user budgets even when each request is inexpensive. Treat rate limits, timeouts, and uncertain results as explicit outcomes with a bounded fallback path. [Model limits](https://docs.typesafe.ai/models).

TypeSafe states it does not train on customer requests/responses, but that is not the same as zero retention. ZDR is advertised for enterprise customers, while the published DPA gives a purpose-based retention period rather than a simple fixed number of days. Confirm our account's actual retention arrangement before sending personal source content. Existing source consent is necessary; it does not by itself settle whether adding another external model destination is permitted. [Legal overview](https://docs.typesafe.ai/legal), [DPA](https://typesafe.ai/legal/data-processing).

**Evaluation and rollout**

1. Build a fixed, labeled replay set of roughly 500–1,000 decisions across space matching, evidence verification and task candidates. Include negatives, ambiguous speakers, Hinglish, history, cancellations, relative dates, duplicate goals, conflicting memories, prompt injection and missing candidates. Start with synthetic or suitably de-identified material until the provider-data setting is settled.
2. Compare deterministic/local methods, the current model path, Jev, and Jev with fallback. Use held-out conversations/users or chronological splits; do not tune thresholds on the final test set.
3. Measure task recall, wrong-space rate, unsupported claims, wrong merges, candidate retrieval recall, precision at coverage, calibration, p50/p95 complete latency, all input tokens, helper calls, retries and fallbacks. Measure from our actual region. Model latency alone is insufficient.
4. Run Jev in shadow mode first. Then allow reversible matching or a verifier with a safe escalation path. Do not allow a missing/failed verdict to silently become an approval; map every expected item explicitly. Keep the current deterministic evidence and write invariants.
5. Pilot one read-only browser workflow with limited scope and clear coverage, such as recent order metadata after the user enables that source. Validate the DOM/schema, capture exact evidence, replay offline fixtures, and test drift/recovery before expanding sites.
6. Add outcome-trained routing and multi-device preference prediction only after we have meaningful feedback. For these, Jev can supply semantic features to a small supervised model; repeatedly calling Jev does not train it. [Semantic feature discovery cookbook](https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery).

This sequence tests whether Jev lowers total cost and latency without losing the evidence, recall, and user-control properties already built into SuperTwin.

**How to interpret the remaining supplied examples**

| Source | Useful signal | Limit of the evidence |
|---|---|---|
| [Nathan Flurry](https://x.com/NathanFlurry/status/2100036101809619314) | Propose candidates, select, execute is a useful programming pattern | Candidates can often come from code or observations; no need for a generative proposal on every iteration |
| [Shantanu Goel's Mario example](https://x.com/shantanugoel/status/2100455295801827769) | A general semantic policy can control a bounded action space with little custom training | Game-demo iteration speed does not establish reliability on user accounts or long workflows |
| [Tencent announcement](https://x.com/TencentAI_News/status/2100143086429217278) | Agent Window and logged-in browser access are a useful product interaction | Browser transport does not provide site-specific extraction or immunity from challenges |
| [Job matching post](https://x.com/sarvagya_kul/status/2100980770206879849) | Parallel candidate evaluation can be inexpensive and fast | The quoted 400 companies / 12 seconds / $0.0005 has no demonstrated hiring-outcome calibration; use a match score, not “probability of getting hired” |

For job matching specifically, apply user-stated constraints such as role, location, experience and required skills; mark missing evidence instead of inventing it. A 400-company set needs batching, independent scoring or hierarchical selection because one Choice supports at most 255 alternatives. Avoid deriving sensitive attributes or presenting an unvalidated employment-outcome probability.

**Recommended decision:** use the user's Jev access for a bounded evaluation, with semantic verification and space matching first. Reuse our browser transport for the first extraction pilot, learn target validation and performance techniques from jev-ultrafast, keep BrowserSkill as an optional existing-browser connector, and borrow Compos's semantic-command and reusable-extractor ideas. Keep full generation, exact calculations, permissions, temporal storage, and the current surface router in their existing roles.
