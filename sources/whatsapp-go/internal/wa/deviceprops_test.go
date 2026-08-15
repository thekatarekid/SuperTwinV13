package wa

import (
	"context"
	"database/sql"
	"testing"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waCompanionReg"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	waLog "go.mau.fi/whatsmeow/util/log"
)

// TestConfigureDeviceProps locks in the history-sync fix: after
// configureDeviceProps() the GLOBAL store.DeviceProps must request full history
// (RequireFullSync=true) with a wide phone-side window, while preserving the
// default capability flags (proves we MUTATE the HistorySyncConfig, not replace
// it). RequireFullSync=false is the root cause of the "0 chats imported" bug.
func TestConfigureDeviceProps(t *testing.T) {
	configureDeviceProps()

	if !store.DeviceProps.GetRequireFullSync() {
		t.Fatalf("RequireFullSync = false, want true (the load-bearing fix)")
	}
	if got := store.DeviceProps.GetOs(); got != "SuperTwinV11" {
		t.Fatalf("Os = %q, want %q", got, "SuperTwinV11")
	}
	if got := store.DeviceProps.GetPlatformType(); got != waCompanionReg.DeviceProps_DESKTOP {
		t.Fatalf("PlatformType = %v, want DESKTOP", got)
	}

	hs := store.DeviceProps.GetHistorySyncConfig()
	if hs == nil {
		t.Fatal("HistorySyncConfig is nil, want configured")
	}
	if got := hs.GetFullSyncDaysLimit(); got != 3650 {
		t.Errorf("FullSyncDaysLimit = %d, want 3650", got)
	}
	if got := hs.GetFullSyncSizeMbLimit(); got != 102400 {
		t.Errorf("FullSyncSizeMbLimit = %d, want 102400", got)
	}
	if got := hs.GetStorageQuotaMb(); got != 102400 {
		t.Errorf("StorageQuotaMb = %d, want 102400", got)
	}
	if got := hs.GetRecentSyncDaysLimit(); got != 90 {
		t.Errorf("RecentSyncDaysLimit = %d, want 90", got)
	}
	// Proves MUTATE-not-replace: a default flag survives our edits.
	if !hs.GetSupportGroupHistory() {
		t.Errorf("SupportGroupHistory = false, want true (default flag must survive mutation)")
	}
}

// TestConfigureClientEnablesPhoneRerequest builds a real (offline) whatsmeow
// client against an in-memory store and asserts configureClient turns on the
// two flags that recover undecryptable messages and keep the socket reconnecting.
// No Connect/network, so it is fully deterministic.
func TestConfigureClientEnablesPhoneRerequest(t *testing.T) {
	ctx := context.Background()

	// foreign_keys(1) is required: the whatsmeow schema upgrade enforces it, and
	// the modernc.org/sqlite driver leaves FKs off unless the pragma is set.
	db, err := sql.Open("sqlite", "file:cfg?mode=memory&cache=shared&_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatalf("open in-memory db: %v", err)
	}
	defer db.Close()

	container := sqlstore.NewWithDB(db, "sqlite3", waLog.Noop)
	if err := container.Upgrade(ctx); err != nil {
		t.Fatalf("upgrade store: %v", err)
	}
	device := container.NewDevice()

	c := whatsmeow.NewClient(device, waLog.Noop)
	configureClient(c)

	if !c.AutomaticMessageRerequestFromPhone {
		t.Errorf("AutomaticMessageRerequestFromPhone = false, want true")
	}
	if !c.EnableAutoReconnect {
		t.Errorf("EnableAutoReconnect = false, want true")
	}
}
