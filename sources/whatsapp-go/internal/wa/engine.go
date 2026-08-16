// Package wa implements the real whatsmeow-backed Engine: QR pairing, session
// persistence via sqlstore, live message streaming, history-sync backfill with
// range filtering, media download, and capped-backoff reconnect.
//
// READ-ONLY: this package contains NO code path that sends a WhatsApp message.
package wa

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waCompanionReg"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"

	// Pure-Go SQLite driver (registers as "sqlite"). No cgo -> self-contained,
	// cross-compilable binary.
	_ "modernc.org/sqlite"

	"github.com/thekatarekid/supertwin/sources/whatsapp-go/internal/protocol"
	"github.com/thekatarekid/supertwin/sources/whatsapp-go/internal/rangefilter"
)

// Engine is the whatsmeow-backed daemon backend.
type Engine struct {
	w         *protocol.Writer
	logf      func(string, ...any)
	sessionDB string
	mediaDir  string
	waLog     waLog.Logger

	container *sqlstore.Container
	device    *store.Device
	client    *whatsmeow.Client

	mu          sync.Mutex
	paused      bool
	importRange protocol.Range
	haveImport  bool
	// pendingHistory buffers automatic post-pairing HistorySync batches that
	// arrive BEFORE an import range is installed (haveImport == false). WhatsApp
	// pushes history within seconds of connect — usually before the user has
	// picked a window in onboarding — so rather than filter those batches by a
	// default and ingest the wrong amount, we hold them until Import/SetRange
	// installs the user's selection, then process them filtered by THAT range
	// (drainPendingHistory). Bounded by maxPendingHistory; overflow flushes at the
	// default so memory stays bounded and no history is lost. Guarded by mu.
	pendingHistory []*events.HistorySync
	emittedChans   map[string]bool
	emittedActs    map[string]bool
	// emittedChanName / emittedActName remember the LAST name we emitted for a
	// channel/actor so we only re-emit an UPDATED channel/actor line when a
	// BETTER name is learned later (contract §R2.4, bug 4). Keyed by canonical
	// ext id.
	emittedChanName map[string]string
	emittedActName  map[string]string
	// groupNames caches resolved group subjects (canonical group JID -> name)
	// so we don't hit GetGroupInfo on every message. Refreshed on GroupInfo
	// name-change events.
	groupNames map[string]string
	// histNames maps a canonical chat JID -> the name the history-sync payload
	// carried for that conversation (Conversation.Name/DisplayName). This is the
	// name the phone itself shows and is AUTHORITATIVE for imported chats,
	// including unsaved businesses whose live VerifiedName is empty on
	// history/ParseWebMessage (contract §R6.1). Preferred over contact-store/live.
	histNames map[string]string
	// histPushNames maps a canonical user JID -> the pushname from
	// HistorySync.Pushnames (JID->pushname). Used to name actors in imported
	// chats when the contact store has nothing (contract §R6.1).
	histPushNames map[string]string
	// oldestPerChat tracks the oldest MessageInfo seen per chat JID, used as the
	// anchor for on-demand (older) history requests during Extend. Keyed by the
	// canonical chat JID string.
	oldestPerChat map[string]types.MessageInfo
	// businessNameQueried remembers canonical DM JIDs whose USync verified-name
	// query (resolveUnsavedBusinessNames) SUCCEEDED with a real name, so a later
	// sweep doesn't re-emit an already-recovered name. A lookup that timed out or
	// returned no verified name is deliberately NOT recorded here, so a subsequent
	// sweep RETRIES it (contract §R3: recovery must be retryable, not once-only).
	// Keyed by canonical JID string.
	businessNameQueried map[string]bool
	// businessChats records canonical DM JIDs identified as a WhatsApp Business /
	// official account (v3-spec §5). A business only proves itself occasionally —
	// one message carrying a verified-name certificate, one BusinessName event, one
	// USync lookup that came back with a verified name — while the channel line is
	// re-emitted many times over a run, so the finding is remembered here and read
	// back on EVERY channel emission. Guarded by mu.
	businessChats map[string]bool

	// refreshInProgress guards refreshKnownNames so overlapping triggers (connect +
	// app-state-sync + offline-sync firing close together, or a reconnect landing
	// mid-sweep) don't run concurrent sweeps that duplicate USync lookups. Set/
	// cleared under mu; a would-be second sweep no-ops while one is running.
	refreshInProgress bool

	// connectedAt is the time the most recent *events.Connected landed. Used purely
	// for diagnostics — refreshKnownNames logs how long after connect each trigger
	// fires so a no-op sweep against a still-streaming history is visible in the log.
	connectedAt time.Time

	// resweepActive guards the single bounded periodic re-sweep goroutine
	// (startBusinessNameResweep) so overlapping triggers can't spawn a pile of
	// competing tickers. Set/cleared under mu.
	resweepActive bool

	// userInfoFn is the seam resolveUnsavedBusinessNames uses to fetch verified
	// business names. Production leaves it nil and the method calls
	// client.GetUserInfo; tests inject a stub to drive the batch/mark/emit logic
	// without a live client. Signature mirrors (*whatsmeow.Client).GetUserInfo.
	userInfoFn func(ctx context.Context, jids []types.JID) (map[types.JID]types.UserInfo, error)

	// contactNameFn is the seam contactName uses to resolve a saved-contact name.
	// Production leaves it nil and contactName reads client.Store.Contacts; tests
	// inject a keyed map so the name-priority chain (contact > verified > pushname)
	// is exercisable without wiring a live whatsmeow contact store. It receives the
	// non-AD JID and returns "" when no real name is stored.
	contactNameFn func(jid types.JID) string

	// parseWebMsgFn is the seam processHistorySync uses to turn a history-sync
	// WebMessageInfo into a parsed message. Production leaves it nil and the loop
	// calls client.ParseWebMessage; tests inject a stub so the history path —
	// including the reactions that ride on SourceWebMsg — is exercisable without a
	// live client. Signature mirrors (*whatsmeow.Client).ParseWebMessage.
	parseWebMsgFn func(chatJID types.JID, webMsg *waWeb.WebMessageInfo) (*events.Message, error)

	ctx    context.Context
	cancel context.CancelFunc

	backfill backfillState

	// quietWindow is how long the daemon waits with NO new history-sync batch
	// (after at least one batch) before declaring an import/extend complete
	// regardless of chats_done vs chats_total (contract §R7.2). Overridable in
	// tests for a short window; defaults to defaultQuietWindow.
	quietWindow time.Duration

	// noHistoryDeadline bounds a run that receives ZERO history-sync batches. The
	// quiet window cannot arm without a batch and the paginator refuses to
	// complete a batch-less import, so without this bound such a run would hold
	// the import banner open forever. Overridable in tests; defaults to
	// defaultNoHistoryDeadline.
	noHistoryDeadline time.Duration

	// onBackfillDone, when non-nil, is invoked AFTER finishBackfill emits the
	// terminal done/backfill_complete for a run. Production leaves it nil; tests
	// set it to observe the async quiet-window completion without racing the
	// writer. Called with the run number that completed.
	onBackfillDone func(run int)

	// extendMu guards a single in-flight extend/import pagination run so a second
	// import/extend command doesn't spawn a competing paginator.
	extendMu     sync.Mutex
	extendActive bool
}

type backfillState struct {
	mu     sync.Mutex
	active bool
	r      protocol.Range
	// chatsDone: canonical chat JIDs that have had >=1 in-range message emitted
	// this run (progress numerator).
	chatsDone map[string]bool
	messages  int
	// chatsTotal is the count of IN-RANGE chats known this run — NOT the total
	// chat count the initial bootstrap delivers (contract §R6.3). Derived from
	// inRange.
	chatsTotal int
	// inRange is the set of canonical chat JIDs whose last activity falls inside
	// the active range. len(inRange) == chatsTotal.
	inRange map[string]bool
	// run counts import/extend runs; the quiet watcher captures the run it was
	// started for and no-ops if a newer run has begun (so a stale watcher can't
	// complete a fresh import). Incremented under mu on each Import/Extend.
	run int
	// batches counts history-sync batches processed THIS run. The quiet window
	// only arms after >=1 batch (contract §R7.2: "after at least one batch").
	batches int
	// lastEventAt is the time the most recent history-sync batch was processed
	// this run. The quiet watcher fires completion once now-lastEventAt exceeds
	// the quiet window (contract §R7.2). Zero until the first batch.
	lastEventAt time.Time
	// startedAt is when this run opened. The quiet watcher measures its
	// zero-batch deadline from here (noHistoryDeadline) so a run that NEVER
	// receives history still terminates instead of holding the banner forever.
	startedAt time.Time
	// isExtend marks an Extend run. An extend's only history is ON_DEMAND
	// responses, which deliberately do NOT bump `batches` (noteHistoryBatch), so
	// its paginator owns completion (contract §R6.4) and is exempt from the
	// zero-batch guard an import is subject to.
	isExtend bool
	// paginatorArmed latches the once-per-run kick of requestOlderHistory. An
	// IMPORT arms it from the first history-sync batch (armPaginator) rather than
	// inline, because the paginator can only work from anchors and anchors only
	// exist once history has been mapped; an EXTEND arms it inline and sets this
	// so the batch path doesn't start a second one.
	paginatorArmed bool
}

// New creates a whatsmeow Engine.
func New(w *protocol.Writer, logf func(string, ...any), sessionDB, mediaDir, logLevel string) *Engine {
	return &Engine{
		w:                   w,
		logf:                logf,
		sessionDB:           sessionDB,
		mediaDir:            mediaDir,
		waLog:               newStderrLogger("wa", logLevel),
		emittedChans:        map[string]bool{},
		emittedActs:         map[string]bool{},
		emittedChanName:     map[string]string{},
		emittedActName:      map[string]string{},
		groupNames:          map[string]string{},
		histNames:           map[string]string{},
		histPushNames:       map[string]string{},
		oldestPerChat:       map[string]types.MessageInfo{},
		businessNameQueried: map[string]bool{},
		businessChats:       map[string]bool{},
		quietWindow:         defaultQuietWindow,
		noHistoryDeadline:   defaultNoHistoryDeadline,
		// The backfill maps MUST be initialized at construction, not only at the
		// start of a user-initiated import/extend run (resetBackfill). WhatsApp
		// pushes HistorySync events AUTOMATICALLY right after pairing/connect —
		// BEFORE any Import/Extend has run — and onHistorySync writes to
		// backfill.chatsDone / backfill.inRange for every in-range message. With
		// nil maps that write panics ("assignment to entry in nil map"), whatsmeow
		// recovers it, and the ENTIRE pushed HistorySync (all conversations/messages)
		// is silently dropped — the "7-day import got no messages" bug. Seeding the
		// maps here makes the pre-import push path safe; resetBackfill still replaces
		// them with fresh maps on each run so per-run counters start clean.
		backfill: backfillState{
			chatsDone: map[string]bool{},
			inRange:   map[string]bool{},
		},
	}
}

// configureDeviceProps mutates whatsmeow's GLOBAL registration properties
// (store.DeviceProps). They are marshalled into the pairing (registration)
// payload by store.(*Device).getRegistrationPayload and are sent to the phone
// ONLY at registration (device.ID == nil), so this takes effect on the NEXT
// FRESH pair, not on an already-linked session.
//
// RequireFullSync is the load-bearing lever: the default (false) tells the phone
// "push only a minimal recent window", which leaves it "paused" and delivers ~0
// history; true flips it to "push full history". The HistorySyncConfig widens the
// phone-side window so it actually serves deep history (onHistorySync still
// range-filters what the daemon ingests, so a generous phone-side window is safe).
//
// It is idempotent (call-once from Start is fine) and MUTATES the existing
// HistorySyncConfig rather than replacing it, so whatsmeow's default capability
// flags (SupportGroupHistory, InlineInitialPayloadInE2EeMsg, ...) survive.
func configureDeviceProps() {
	store.DeviceProps.Os = proto.String("SuperTwinV11")
	store.DeviceProps.PlatformType = waCompanionReg.DeviceProps_DESKTOP.Enum()
	store.DeviceProps.RequireFullSync = proto.Bool(true)
	if store.DeviceProps.HistorySyncConfig == nil { // defensive: keep working if a future bump nils it
		store.DeviceProps.HistorySyncConfig = &waCompanionReg.DeviceProps_HistorySyncConfig{}
	}
	// MUTATE (do not replace) so the default capability flags survive.
	hs := store.DeviceProps.HistorySyncConfig
	hs.FullSyncDaysLimit = proto.Uint32(3650)     // ~10y; phone caps to what it retains
	hs.FullSyncSizeMbLimit = proto.Uint32(102400) // 100 GB — effectively unbounded
	hs.StorageQuotaMb = proto.Uint32(102400)      // 100 GB (default was 10240)
	hs.RecentSyncDaysLimit = proto.Uint32(90)     // recent chunk populates fast; full sync backfills deeper
}

// configureClient sets client-level flags before Connect.
// AutomaticMessageRerequestFromPhone re-requests undecryptable messages from the
// primary device (peer protocol message to our OWN device, not a chat send), which
// recovers from the "no session found"/"no signed prekey" Signal-session gaps. It
// is nil-safe: pendingPhoneRerequests is initialized in whatsmeow.NewClient.
func configureClient(c *whatsmeow.Client) {
	c.EnableAutoReconnect = true
	c.AutomaticMessageRerequestFromPhone = true
}

// Start opens the sqlstore, restores or creates a device, wires the event
// handler, and (if a session exists) auto-connects toward online.
func (e *Engine) Start(ctx context.Context) error {
	e.ctx, e.cancel = context.WithCancel(ctx)

	if err := os.MkdirAll(filepath.Dir(e.sessionDB), 0o755); err != nil {
		return fmt.Errorf("create session dir: %w", err)
	}
	if err := os.MkdirAll(e.mediaDir, 0o755); err != nil {
		return fmt.Errorf("create media dir: %w", err)
	}

	// Open the pure-Go SQLite driver ("sqlite") but tell whatsmeow the dialect
	// is "sqlite3" (its dbutil dialect name). Foreign keys on, WAL for concurrency.
	dsn := "file:" + e.sessionDB + "?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return fmt.Errorf("open session db: %w", err)
	}
	db.SetMaxOpenConns(1) // SQLite: serialize writes to avoid lock churn.
	container := sqlstore.NewWithDB(db, "sqlite3", e.waLog)
	if err := container.Upgrade(e.ctx); err != nil {
		return fmt.Errorf("upgrade session store: %w", err)
	}
	e.container = container

	device, err := container.GetFirstDevice(e.ctx)
	if err != nil {
		return fmt.Errorf("get device: %w", err)
	}
	e.device = device

	// Set the global registration props BEFORE NewClient/pairing so a fresh pair
	// requests full history (RequireFullSync=true). Takes effect on a fresh pair only.
	configureDeviceProps()
	e.client = whatsmeow.NewClient(device, e.waLog)
	configureClient(e.client)
	e.client.AddEventHandler(e.handleEvent)

	if err := e.w.Ready(); err != nil {
		return err
	}

	if e.client.Store.ID == nil {
		// No session yet: need pairing.
		_ = e.w.Status(protocol.StateNeedPairing, "no session; awaiting pairing", "", "")
		return nil
	}

	// Existing session: auto-connect toward online.
	_ = e.w.Status(protocol.StateStarting, "restoring session", jidStr(e.client.Store.ID), e.client.Store.PushName)
	go e.connectWithBackoff()
	return nil
}

// connectWithBackoff connects the client with capped exponential backoff,
// emitting reconnecting/online status. whatsmeow's own auto-reconnect handles
// mid-session drops; this loop covers the initial connect and hard failures.
func (e *Engine) connectWithBackoff() {
	backoff := time.Second
	const maxBackoff = 60 * time.Second
	for {
		select {
		case <-e.ctx.Done():
			return
		default:
		}
		if e.client.IsConnected() {
			return
		}
		err := e.client.Connect()
		if err == nil {
			return
		}
		e.logf("connect failed: %v (retry in %s)", err, backoff)
		_ = e.w.Status(protocol.StateReconnecting, err.Error(), "", "")
		select {
		case <-e.ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff *= 2
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
}

// StartPairing begins QR pairing, or no-ops (status online) if already paired.
func (e *Engine) StartPairing() {
	if e.client.Store.ID != nil {
		_ = e.w.Status(protocol.StateOnline, "already paired", jidStr(e.client.Store.ID), e.client.Store.PushName)
		if !e.client.IsConnected() {
			go e.connectWithBackoff()
		}
		return
	}
	go e.pair()
}

func (e *Engine) pair() {
	qrChan, err := e.client.GetQRChannel(e.ctx)
	if err != nil {
		// Already logged in between check and here.
		if errors.Is(err, whatsmeow.ErrQRStoreContainsID) {
			_ = e.w.Status(protocol.StateOnline, "already paired", jidStr(e.client.Store.ID), e.client.Store.PushName)
			return
		}
		_ = e.w.Error("qr_channel", err.Error(), false)
		return
	}
	if err := e.client.Connect(); err != nil {
		_ = e.w.Error("connect", err.Error(), false)
		return
	}
	_ = e.w.Status(protocol.StatePairing, "scan the QR code", "", "")
	for item := range qrChan {
		switch item.Event {
		case "code":
			_ = e.w.QR(item.Code, int(item.Timeout.Seconds()))
		case "success":
			_ = e.w.Paired(jidStr(e.client.Store.ID), e.client.Store.PushName)
			_ = e.w.Status(protocol.StateOnline, "paired", jidStr(e.client.Store.ID), e.client.Store.PushName)
			return
		case "timeout":
			_ = e.w.Error("qr_timeout", "QR code timed out", false)
			_ = e.w.Status(protocol.StateNeedPairing, "qr timeout", "", "")
			return
		default:
			if item.Error != nil {
				_ = e.w.Error("pair_error", item.Error.Error(), false)
			}
		}
	}
}

// Import requests history sync for the given range and records the active
// import range so history-sync events are filtered accordingly.
//
// It starts the back-pagination paginator only once ANCHORS EXIST. The paginator
// walks e.oldestPerChat, which trackAnchor fills from messages that have
// ALREADY been mapped, so calling it unconditionally here — before any history
// had arrived — always found that map empty, hit `len(pending)==0` on its first
// round and returned having sent nothing. Worse, its settle path then fired
// finishBackfill, so a run "completed" seconds BEFORE the first batch landed and
// the app reported a finished backfill over whatever shallow bootstrap arrived
// afterwards.
//
// Anchors can exist at this point for one reason: the buffered post-pairing
// bootstrap was just drained. Otherwise arming waits for the first history batch
// (armPaginator, from processHistorySync), and if history never arrives the
// quiet watcher's zero-batch deadline still terminates the run.
func (e *Engine) Import(r protocol.Range) {
	e.logf("import: entry range=%s anchors=%d", r, e.anchorCount())
	e.mu.Lock()
	e.importRange = r
	e.haveImport = true
	e.mu.Unlock()

	// The automatic post-pairing HistorySync usually lands BEFORE the user picks a
	// range, so it was buffered (onHistorySync). Process that buffered bootstrap
	// now — filtered by the USER'S selection — so the imported window matches the
	// picker. Drain BEFORE resetBackfill so it runs with backfill.active==false:
	// its messages are ingested and its anchors recorded, but it does NOT drive run
	// completion. (With active==true it could fire backfill_complete on the first
	// recent batch — coveredAll counts only the pushed recent chats, and the
	// push's server-progress reaches ~100% of the transfer, not of the range —
	// clearing the banner before the paginator widens to the full range.)
	// Completion stays owned by the paginator settle / quiet watcher, exactly as
	// before this buffering existed; resetBackfill then zeroes the counters.
	e.drainPendingHistory()

	run := e.resetBackfill(r, false)

	_ = e.w.Status(protocol.StateSyncing, "importing history", "", "")
	_ = e.w.Progress("backfill", 0, 0, 0, false, r)
	// A large/entire import plateaus below chats_total because WhatsApp never
	// delivers history for inactive chats; the quiet watcher clears the banner
	// when history-sync batches stop arriving (contract §R7.2).
	go e.watchQuietCompletion(run, r)
	// whatsmeow delivers the on-device history bootstrap via HistorySync events
	// automatically after connect; those are range-filtered in onHistorySync.
	// The initial import primarily surfaces that bootstrapped history.
	//
	// If the drain above already produced anchors, the whole bootstrap may have
	// arrived and been buffered BEFORE this run opened — no further batch is owed,
	// so waiting for one would leave the paginator armed forever. Start it now.
	// With no anchors there is nothing to page from and arming waits for the first
	// batch.
	if anchors := e.anchorCount(); anchors > 0 {
		if armedRun, ok := e.armPaginator(); ok {
			e.logf("import: run %d open range=%s — starting paginator over %d anchors from the drained bootstrap", armedRun, r, anchors)
			e.requestOlderHistory(r)
			return
		}
	}
	e.logf("import: run %d open range=%s (no anchors yet; paginator deferred to the first history batch)", run, r)
}

// Extend requests OLDER on-demand history to widen coverage to range r
// (contract §R4.1, bug 15). It resets the backfill counters for this run so the
// extend's progress/backfill_complete reflect only the newly pulled history,
// then issues on-demand history-sync requests for every chat whose oldest-known
// message is still NEWER than the new cutoff (i.e. there is a gap to fill).
// Unlike Import it DOES start the paginator inline: an extend has no automatic
// history push of its own to wait for, and its anchors come either from this
// process's own traffic or from the worker's seed_anchors (SeedAnchors). An
// extend with zero anchors can only ever be a no-op, so that case is logged
// explicitly rather than silently paginating nothing.
func (e *Engine) Extend(r protocol.Range) {
	anchors := e.anchorCount()
	e.logf("extend: entry range=%s anchors=%d", r, anchors)
	e.mu.Lock()
	e.importRange = r
	e.haveImport = true
	e.mu.Unlock()

	run := e.resetBackfill(r, true)

	_ = e.w.Status(protocol.StateSyncing, "extending history", "", "")
	_ = e.w.Progress("backfill", 0, 0, 0, false, r)
	// Quiet watcher is a fallback: if no ON_DEMAND history-sync response ever
	// arrives (server has nothing older), it still completes the run so the
	// banner clears (contract §R7.2). The paginator's own completion normally
	// wins first; finishBackfill makes both idempotent.
	go e.watchQuietCompletion(run, r)
	// Latch the once-per-run arm here so a history batch landing mid-extend
	// doesn't start a competing paginator.
	e.armPaginatorForRun(run)
	if anchors == 0 {
		e.logf("extend: run %d has NO anchors — nothing to paginate; a restarted daemon needs the worker's seed_anchors before extend can widen anything", run)
	}
	e.requestOlderHistory(r)
}

// SeedAnchors installs back-pagination anchors supplied by the worker
// (`seed_anchors`), making Extend survive a daemon restart.
//
// e.oldestPerChat is in-memory and is filled ONLY by trackAnchor, from messages
// this process has mapped. After a restart it is empty, so requestOlderHistory
// finds no chat with a gap, sends nothing, and "Extend history" silently does
// nothing — the daemon has no durable record of its own to rebuild from
// (whatsmeow's sqlstore keeps no message timestamps; see protocol.Anchor). The
// worker's events table does, so it seeds them.
//
// Seeding goes through trackAnchor, so a seed can only ever move an anchor
// OLDER: a live message already seen this process wins if it is older, and a
// stale seed can never walk an anchor forward and re-request history already
// held.
func (e *Engine) SeedAnchors(anchors []protocol.Anchor) {
	seeded, skipped := 0, 0
	for _, a := range anchors {
		info, ok := anchorMessageInfo(a)
		if !ok {
			skipped++
			continue
		}
		e.trackAnchor(info, jidString(info.Chat))
		seeded++
	}
	e.logf("seed_anchors: %d seeded, %d skipped (incomplete/unparseable), %d anchors known", seeded, skipped, e.anchorCount())
}

// anchorMessageInfo converts one wire Anchor into the MessageInfo the paginator
// hands to BuildHistorySyncRequest. All four fields are required — WhatsApp is
// asked for "messages older than THIS message in THIS chat", so a missing id or
// timestamp makes the request meaningless — hence ok=false rather than a
// partially-filled anchor that would issue a bad page request.
func anchorMessageInfo(a protocol.Anchor) (types.MessageInfo, bool) {
	if a.ChatJID == "" || a.MsgID == "" || a.TS == "" {
		return types.MessageInfo{}, false
	}
	chat, err := types.ParseJID(a.ChatJID)
	if err != nil || chat.IsEmpty() || skipChatJID(chat) {
		return types.MessageInfo{}, false
	}
	ts, err := protocol.ParseTime(a.TS)
	if err != nil || ts.IsZero() {
		return types.MessageInfo{}, false
	}
	return types.MessageInfo{
		ID:        a.MsgID,
		Timestamp: ts,
		MessageSource: types.MessageSource{
			Chat:     chat.ToNonAD(),
			IsFromMe: a.FromMe,
		},
	}, true
}

// anchorCount returns how many chats currently have a back-pagination anchor.
func (e *Engine) anchorCount() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.oldestPerChat)
}

// SetRange installs the active import range WITHOUT starting a backfill run
// (contract §4). The worker calls this at connect — BEFORE WhatsApp can push its
// automatic post-pairing HistorySync — with the persisted last-used range (or
// the default) so that pushed history is filtered to the intended range instead
// of flooding all history. Unlike Import/Extend it does NOT reset the backfill,
// start a paginator, or emit any progress; it only records the range that
// onHistorySync's filter reads. A later Import/Extend still overwrites it and
// drives the actual run.
func (e *Engine) SetRange(r protocol.Range) {
	e.mu.Lock()
	e.importRange = r
	e.haveImport = true
	e.mu.Unlock()
	// Process any history buffered before the range was known, filtered by r.
	e.drainPendingHistory()
}

// resetBackfill (re)initializes the backfill counters for a new import/extend
// run and returns the new run number (used by the quiet watcher to detect a
// superseding run). `extend` marks an Extend run, whose completion rules differ
// (see backfillState.isExtend). Callers hold no locks.
func (e *Engine) resetBackfill(r protocol.Range, extend bool) int {
	e.backfill.mu.Lock()
	defer e.backfill.mu.Unlock()
	e.backfill.active = true
	e.backfill.r = r
	e.backfill.chatsDone = map[string]bool{}
	e.backfill.messages = 0
	e.backfill.chatsTotal = 0
	e.backfill.inRange = map[string]bool{}
	e.backfill.batches = 0
	e.backfill.lastEventAt = time.Time{}
	e.backfill.startedAt = time.Now()
	e.backfill.isExtend = extend
	e.backfill.paginatorArmed = false
	e.backfill.run++
	return e.backfill.run
}

// armPaginator reports whether the CALLER should start this run's paginator,
// flipping the once-per-run latch when it says yes, and returns the run it armed.
// It refuses when no run is active, when the run is an extend (Extend arms its
// own paginator inline), or when the paginator was already armed this run.
//
// This is the fix for the paginator that could never do anything: it is now
// armed from processHistorySync, once real anchors exist, instead of inline from
// Import where e.oldestPerChat is guaranteed empty.
func (e *Engine) armPaginator() (int, bool) {
	e.backfill.mu.Lock()
	defer e.backfill.mu.Unlock()
	if !e.backfill.active || e.backfill.isExtend || e.backfill.paginatorArmed {
		return e.backfill.run, false
	}
	e.backfill.paginatorArmed = true
	return e.backfill.run, true
}

// armPaginatorForRun latches the arm for a run the caller is starting the
// paginator for itself (Extend), so a history batch landing mid-run does not
// start a competing one.
func (e *Engine) armPaginatorForRun(run int) {
	e.backfill.mu.Lock()
	if e.backfill.run == run {
		e.backfill.paginatorArmed = true
	}
	e.backfill.mu.Unlock()
}

// noteHistoryBatch records that a history-sync batch was processed this run:
// it bumps the batch count and stamps lastEventAt so the quiet watcher's window
// restarts (contract §R7.2 — reset the timer on each batch). Called from
// onHistorySync for every non-empty batch.
//
// Only the AUTOMATIC bootstrap/recent/full history arms & refreshes the import
// quiet window. The daemon's OWN on-demand back-pagination (ON_DEMAND responses)
// must NOT keep the import banner open — otherwise a deep 30d/90d/entire import
// shows "Importing…" for minutes while we page older history in the background.
// The banner should clear a quiet window after the recent history settles; the
// paginator then keeps filling older messages (which just nudge the inbox). An
// EXTEND run (only ON_DEMAND batches) does not rely on this window — it completes
// via the paginator's own finishBackfill (requestOlderHistory).
func (e *Engine) noteHistoryBatch(onDemand bool) {
	if onDemand {
		return
	}
	e.backfill.mu.Lock()
	if e.backfill.active {
		e.backfill.batches++
		e.backfill.lastEventAt = time.Now()
	}
	e.backfill.mu.Unlock()
}

// watchQuietCompletion is the quiet-window fallback that guarantees a large or
// entire import completes even when chats_done never reaches chats_total
// (contract §R7.2). WhatsApp does not deliver history for inactive/old chats, so
// chats_done plateaus and neither the server-progress nor the covered-all path
// in maybeCompleteBackfill ever fires. This watcher fires completion once at
// least one history-sync batch has been processed AND no new batch has arrived
// for e.quietWindow.
//
// It ticks at a fraction of the window and, each tick, checks the run's
// lastEventAt. It exits without completing if a newer run superseded this one
// (run mismatch), if the run already completed elsewhere (finishBackfill lost
// the race), or if the engine context is cancelled. ON_DEMAND (extend paginator)
// responses also flow through onHistorySync -> noteHistoryBatch, so an actively
// paginating extend keeps this timer fresh and the paginator's own completion
// normally wins first; finishBackfill keeps both idempotent.
func (e *Engine) watchQuietCompletion(run int, r protocol.Range) {
	window := e.quietWindow
	if window <= 0 {
		window = defaultQuietWindow
	}
	deadline := e.noHistoryDeadline
	if deadline <= 0 {
		deadline = defaultNoHistoryDeadline
	}
	tick := window / 4
	if tick <= 0 {
		tick = window
	}
	t := time.NewTicker(tick)
	defer t.Stop()

	for {
		select {
		case <-e.ctx.Done():
			return
		case <-t.C:
		}

		e.backfill.mu.Lock()
		active := e.backfill.active
		curRun := e.backfill.run
		batches := e.backfill.batches
		last := e.backfill.lastEventAt
		started := e.backfill.startedAt
		total := e.backfill.chatsTotal
		done := len(e.backfill.chatsDone)
		msgs := e.backfill.messages
		e.backfill.mu.Unlock()

		if curRun != run || !active {
			return // superseded by a newer run, or already completed elsewhere.
		}
		if batches == 0 || last.IsZero() {
			// No batch yet: the quiet window cannot arm (contract §R7.2) and the
			// paginator refuses to complete a batch-less import
			// (finishBackfillFromPaginator), so nothing else can close this run.
			// Bound it: give history a real chance to show up, then complete and
			// say plainly that NONE arrived — the one shape that used to be
			// reported as a finished backfill.
			if !started.IsZero() && time.Since(started) >= deadline {
				if e.finishBackfill(run, r, done, total, msgs) {
					e.logf("import/extend completed with ZERO history-sync batches after %s: WhatsApp delivered no history for this run (range %s)", deadline, r)
				}
				return
			}
			continue
		}
		if time.Since(last) < window {
			continue // still within the quiet window; a batch arrived recently.
		}

		// Quiet window elapsed with the backfill still open: complete it now
		// regardless of chats_done vs chats_total. finishBackfill is idempotent,
		// so if the paginator/server-progress path already completed this run this
		// is a no-op.
		if e.finishBackfill(run, r, done, total, msgs) {
			e.logf("import/extend completed via quiet window (%.0fs idle, %d/%d chats, %d msgs, range %s)",
				window.Seconds(), done, total, msgs, r)
		}
		return
	}
}

// finishBackfill atomically closes the active backfill run and emits the
// terminal progress done:true + backfill_complete EXACTLY ONCE (contract §R7.2
// once-only guard). It returns true only for the caller that actually closed the
// run; all later callers (quiet watcher, server-progress path, paginator settle)
// see active=false and return false without re-emitting. `run` guards against a
// stale caller completing a newer run.
func (e *Engine) finishBackfill(run int, r protocol.Range, done, total, msgs int) bool {
	e.backfill.mu.Lock()
	if !e.backfill.active || e.backfill.run != run {
		e.backfill.mu.Unlock()
		return false
	}
	e.backfill.active = false
	batches := e.backfill.batches
	isExtend := e.backfill.isExtend
	elapsed := time.Since(e.backfill.startedAt)
	e.backfill.mu.Unlock()

	kind := "import"
	if isExtend {
		kind = "extend"
	}
	e.logf("%s: run %d closed after %.1fs — %d batches, %d/%d chats, %d msgs, %d anchors (range %s)",
		kind, run, elapsed.Seconds(), batches, done, total, msgs, e.anchorCount(), r)

	_ = e.w.Progress("backfill", done, total, msgs, true, r)
	_ = e.w.BackfillComplete(r, done, msgs)
	// The full in-range set is now loaded, so the candidate DMs and the contact
	// store are as populated as this import will make them. Kick a final sweep so
	// any business introduced late in the backfill gets its verified name resolved
	// (contract §R3, bug: RC7). refreshInProgress single-flights it.
	go e.refreshKnownNames("backfill-complete")
	if e.onBackfillDone != nil {
		e.onBackfillDone(run)
	}
	return true
}

// currentBackfillRun returns the current run number (for the paginator to pass
// to finishBackfill).
func (e *Engine) currentBackfillRun() int {
	e.backfill.mu.Lock()
	defer e.backfill.mu.Unlock()
	return e.backfill.run
}

// finishBackfillFromPaginator closes the run on paginator settle, but REFUSES to
// do so for an IMPORT run in the two shapes where a settle means nothing:
//
//  1. Zero batches AND zero anchors. A settle means "no chat has a gap left to
//     fill", which over an empty anchor map is vacuously true after zero
//     requests — exactly how a run used to report a completed backfill 15
//     seconds BEFORE the first batch of the import it was supposed to cover.
//     With no batch and no anchor this run has seen nothing at all to judge by.
//  2. History is still arriving (the last batch is within the quiet window). The
//     paginator can drain the anchors it has long before WhatsApp finishes
//     pushing, and declaring done mid-stream is what clears the banner over a
//     partial import.
//
// Both refusals are safe because an import run always has watchQuietCompletion
// behind it: the quiet window closes case 2 once batches stop, and the
// zero-batch deadline closes case 1 if history never comes.
//
// An EXTEND run is exempt from both: its only history is ON_DEMAND responses,
// which never bump `batches` by design (noteHistoryBatch), and its paginator owns
// completion per contract §R6.4.
func (e *Engine) finishBackfillFromPaginator(run int, r protocol.Range) bool {
	e.backfill.mu.Lock()
	active := e.backfill.active
	batches := e.backfill.batches
	last := e.backfill.lastEventAt
	isExtend := e.backfill.isExtend
	e.backfill.mu.Unlock()

	if active && !isExtend {
		window := e.quietWindow
		if window <= 0 {
			window = defaultQuietWindow
		}
		switch {
		case batches == 0 && e.anchorCount() == 0:
			e.logf("paginator: NOT completing run %d — 0 history-sync batches and 0 anchors, a settle here proves nothing; leaving it to the quiet watcher (range %s)", run, r)
			return false
		case !last.IsZero() && time.Since(last) < window:
			e.logf("paginator: NOT completing run %d — history still arriving (last batch %.1fs ago, quiet window %s); leaving it to the quiet watcher (range %s)",
				run, time.Since(last).Seconds(), window, r)
			return false
		}
	}
	return e.finishBackfill(run, r, e.backfillChats(), e.backfillChatsTotal(), e.backfillMessages())
}

const (
	// defaultQuietWindow is the no-new-history-sync-batch idle period after which
	// a large/entire import is declared complete regardless of chats_done vs
	// chats_total (contract §R7.2: ~10–12s). Overridable via e.quietWindow (tests
	// use a short window).
	defaultQuietWindow = 11 * time.Second

	// defaultNoHistoryDeadline bounds a run that receives ZERO history-sync
	// batches. Neither the quiet window (needs >=1 batch) nor the paginator
	// (finishBackfillFromPaginator refuses a batch-less import) can close such a
	// run, so this is the terminator that keeps the import banner bounded. It is
	// deliberately far longer than the quiet window: WhatsApp's automatic push can
	// take tens of seconds to produce its first batch after connect, and cutting a
	// run short would report an empty import over history that was still coming.
	defaultNoHistoryDeadline = 90 * time.Second

	// defaultPushedRange is the BOUNDED range onHistorySync falls back to when no
	// range has been installed yet (no Import/Extend and no connect-time SetRange).
	// WhatsApp pushes a HistorySync automatically right after pairing/connect,
	// BEFORE the worker sends any range; without a bound that flood ingested ALL
	// history (back to January) and overloaded extraction. 30d keeps a fresh,
	// range-less daemon safe standalone while still surfacing recent history; the
	// worker normally installs the persisted/default range via SetRange before
	// history arrives, and the user's "Extend history" can always pull older.
	defaultPushedRange = protocol.Range30d
)

// requestOlderHistory drives PAGINATED on-demand history-sync for import/extend
// to range r (contract §R6.4). It considers EVERY chat known from history-sync
// whose oldest-known message is still NEWER than the cutoff (a gap to fill) and
// walks each backward: it issues on-demand requests in batches (respecting an
// in-flight cap), waits for the async ON_DEMAND *events.HistorySync responses
// (which advance each chat's anchor via trackAnchor as older messages arrive),
// then re-issues for chats that still have a gap — until every chat reaches the
// cutoff, hits the per-chat page cap, or the server stops returning older
// messages (anchor no longer advances). It fires backfill_complete when the run
// settles.
//
// Each on-demand request is a PEER protocol message to the user's OWN primary
// device (SendPeerMessage) — NOT a chat message to any contact — so the
// read-only invariant holds. The worker dedupes overlaps (contract §4).
//
// HONEST LIMIT: WhatsApp only re-serves history it still retains for a linked
// device, so different chats bottom out at different dates; a chat can hit
// "no more" long before the cutoff. This is expected and not full coverage.
func (e *Engine) requestOlderHistory(r protocol.Range) {
	run := e.currentBackfillRun()
	anchors := e.anchorCount()
	if e.client == nil || e.client.Store == nil || e.client.Store.ID == nil {
		// No session/client: no history will ever arrive, so complete the run now
		// (through the guarded once-only path) instead of leaving the banner open.
		e.logf("paginator: run %d not issued — no session/client (range %s, %d anchors)", run, r, anchors)
		e.finishBackfillFromPaginator(run, r)
		return
	}

	// Only one paginator at a time; a new import/extend supersedes counters but
	// reuses the running loop's range via importRange.
	e.extendMu.Lock()
	if e.extendActive {
		e.extendMu.Unlock()
		e.logf("paginator: run %d not issued — a paginator is already running (range %s, %d anchors)", run, r, anchors)
		return
	}
	e.extendActive = true
	e.extendMu.Unlock()

	e.logf("paginator: run %d starting over %d anchors (range %s)", run, anchors, r)

	go func() {
		defer func() {
			e.extendMu.Lock()
			e.extendActive = false
			e.extendMu.Unlock()
		}()
		rounds, sent := e.paginateOlderHistory(r)
		// The paginator has settled (every in-range chat reached the cutoff or the
		// server stopped serving older history). Complete the run — but ONCE, and
		// only if this run has actually seen history, so a settle over zero anchors
		// can no longer close a run before its first batch even lands
		// (finishBackfillFromPaginator). Idempotent with the quiet watcher and the
		// server-progress path (contract §R7.2 once-only guard).
		e.logf("paginator: run %d settled after %d rounds, %d on-demand requests, %d anchors (range %s)",
			run, rounds, sent, e.anchorCount(), r)
		e.finishBackfillFromPaginator(run, r)
	}()
}

// paginateOlderHistory is the paginating core of requestOlderHistory. It loops
// per-round: pick chats still short of the cutoff (and under the page cap), send
// a capped batch of on-demand requests, wait a poll interval for responses to
// advance anchors, and repeat. It stops when no chat needs more, or when a whole
// batch produced no anchor movement for maxStalls consecutive rounds (server
// exhausted), or when the engine context is cancelled.
//
// It returns how many rounds it ran and how many on-demand requests it actually
// sent, so the caller can log whether the paginator did any work at all — a
// silent zero-request settle is the failure mode this whole path exists to make
// visible.
func (e *Engine) paginateOlderHistory(r protocol.Range) (rounds, sent int) {
	now := time.Now()
	cutoff := rangefilter.RangeCutoff(r, now)

	// pagesUsed tracks per-chat pages issued this run (cap: maxPagesPerChat).
	pagesUsed := map[string]int{}
	stalls := 0

	for round := 0; round < maxExtendRounds; round++ {
		rounds = round + 1
		select {
		case <-e.ctx.Done():
			return rounds, sent
		default:
		}

		// Snapshot anchors: chats whose oldest-known message is still newer than
		// the cutoff have a gap; skip chats that hit the per-chat page cap.
		e.mu.Lock()
		type anchorEntry struct {
			key  string
			info types.MessageInfo
		}
		var pending []anchorEntry
		covered, capped := 0, 0
		for key, info := range e.oldestPerChat {
			if !info.Timestamp.After(cutoff) {
				covered++
				continue // already covers the cutoff
			}
			if pagesUsed[key] >= maxPagesPerChat {
				capped++
				continue // per-chat cap reached (honest limit / rate control)
			}
			pending = append(pending, anchorEntry{key: key, info: info})
		}
		known := len(e.oldestPerChat)
		// Remember the anchors we're about to request against, to detect movement.
		before := make(map[string]time.Time, len(pending))
		for _, p := range pending {
			before[p.key] = p.info.Timestamp
		}
		e.mu.Unlock()

		if len(pending) == 0 {
			e.logf("paginator: round %d issued nothing — %d anchors known (%d already past the cutoff, %d at the page cap), range %s",
				rounds, known, covered, capped, r)
			return rounds, sent // every in-range chat reaches the cutoff or hit its cap
		}

		// Issue a capped batch of requests (in-flight cap = maxInFlight).
		roundSent := 0
		for _, p := range pending {
			if roundSent >= maxInFlight {
				break
			}
			anchor := p.info
			msg := e.client.BuildHistorySyncRequest(&anchor, historyChunkSize)
			if msg == nil {
				continue
			}
			ctx, cancel := context.WithTimeout(e.ctx, 30*time.Second)
			_, err := e.client.SendPeerMessage(ctx, msg)
			cancel()
			if err != nil {
				e.logf("history sync request failed for %s: %v", anchor.Chat.String(), err)
				continue
			}
			pagesUsed[p.key]++
			roundSent++
		}
		sent += roundSent
		if roundSent == 0 {
			e.logf("paginator: round %d sent 0 of %d pending requests (build/send failed); stopping (range %s)", rounds, len(pending), r)
			return rounds, sent // nothing could be sent (all capped or build failed)
		}
		e.logf("paginator: round %d requested %d of %d chats with a gap (%d anchors known, range %s)",
			rounds, roundSent, len(pending), known, r)

		// Wait for ON_DEMAND responses to arrive and advance anchors.
		select {
		case <-e.ctx.Done():
			return rounds, sent
		case <-time.After(extendPollInterval):
		}

		// Did any requested chat's anchor move older? If not for maxStalls rounds,
		// the server has stopped serving older history (honest limit) — stop.
		moved := false
		e.mu.Lock()
		for key, prevTS := range before {
			if info, ok := e.oldestPerChat[key]; ok && info.Timestamp.Before(prevTS) {
				moved = true
				break
			}
		}
		e.mu.Unlock()
		if moved {
			stalls = 0
		} else {
			stalls++
			if stalls >= maxStalls {
				e.logf("paginator: server returned no older history for %d rounds; stopping after %d rounds / %d requests (range %s)", stalls, rounds, sent, r)
				return rounds, sent
			}
		}
	}
	e.logf("paginator: hit the %d-round cap after %d requests (range %s)", maxExtendRounds, sent, r)
	return rounds, sent
}

const (
	// historyChunkSize is the number of older messages requested per on-demand
	// page. WhatsApp caps on-demand requests; ~50 is the conventional page size.
	historyChunkSize = 50
	// maxPagesPerChat caps how many older pages we request per chat in one run so
	// a single deep chat can't monopolize the rate budget.
	maxPagesPerChat = 20
	// maxInFlight caps concurrent on-demand requests per round (rate control).
	maxInFlight = 5
	// maxExtendRounds caps total pagination rounds (safety valve).
	maxExtendRounds = 200
	// extendPollInterval is how long we wait after a batch for ON_DEMAND
	// responses to arrive and advance anchors before the next round.
	extendPollInterval = 3 * time.Second
	// maxStalls is how many consecutive no-movement rounds mean "server exhausted".
	maxStalls = 2
)

func (e *Engine) backfillChatsTotal() int {
	e.backfill.mu.Lock()
	defer e.backfill.mu.Unlock()
	return e.backfill.chatsTotal
}

func (e *Engine) backfillChats() int {
	e.backfill.mu.Lock()
	defer e.backfill.mu.Unlock()
	return len(e.backfill.chatsDone)
}

func (e *Engine) backfillMessages() int {
	e.backfill.mu.Lock()
	defer e.backfill.mu.Unlock()
	return e.backfill.messages
}

// Pause halts event emission and disconnects the socket (kill-switch).
func (e *Engine) Pause() {
	e.mu.Lock()
	e.paused = true
	e.mu.Unlock()
	if e.client != nil && e.client.IsConnected() {
		e.client.Disconnect()
	}
	_ = e.w.Status(protocol.StateReconnecting, "paused (kill-switch)", "", "")
	e.logf("paused")
}

// Resume re-enables emission and reconnects.
func (e *Engine) Resume() {
	e.mu.Lock()
	e.paused = false
	e.mu.Unlock()
	if e.client != nil && e.client.Store.ID != nil && !e.client.IsConnected() {
		go e.connectWithBackoff()
	}
	e.logf("resumed")
}

// Logout FULLY clears the whatsmeow session so the next (fresh) process starts
// with no device -> need_pairing (contract §R3.1). whatsmeow's Client.Logout
// unlinks the device server-side AND deletes the local device store — but per
// its docs, if the unlink request fails the local data is NOT deleted. To
// guarantee a clean, re-pairable state we fall back to Disconnect +
// Store.Delete so a stale session can never survive a logout. After this the
// daemon exits 0 (see daemon.handleCommand) and the worker restarts fresh.
//
// READ-ONLY: unlinking our OWN device is not a chat send.
func (e *Engine) Logout() {
	if e.client == nil {
		_ = e.w.Status(protocol.StateLoggedOut, "logged out (no client)", "", "")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := e.client.Logout(ctx); err != nil {
		// Server unlink failed: force-clear locally so the next start re-pairs.
		e.logf("logout error: %v; forcing local session clear", err)
		e.client.Disconnect()
		if e.client.Store != nil {
			if derr := e.client.Store.Delete(context.Background()); derr != nil {
				e.logf("force store delete failed: %v", derr)
			}
		}
	}
	_ = e.w.Status(protocol.StateLoggedOut, "logged out", "", "")
}

// Shutdown disconnects and closes the session store.
func (e *Engine) Shutdown() {
	if e.cancel != nil {
		e.cancel()
	}
	if e.client != nil {
		e.client.Disconnect()
	}
	if e.container != nil {
		_ = e.container.Close()
	}
	e.logf("shutdown complete")
}

func (e *Engine) isPaused() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.paused
}

func (e *Engine) selfJID() string {
	if e.client != nil && e.client.Store.ID != nil {
		return jidStr(e.client.Store.ID)
	}
	return ""
}

func jidStr(j *types.JID) string {
	if j == nil {
		return ""
	}
	return j.ToNonAD().String()
}
