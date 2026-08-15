# Rich media ingestion — wire contract

Frozen contract so the Go daemon and the TypeScript worker can be built in
parallel. Neither side may change a field name here without changing both.

Current state (verified, not assumed):

- The daemon **already** downloads image/video/audio/document/sticker media,
  emits `reaction` events with the target id, and emits `reply_to`.
- The daemon **already** renders template / list / buttons / interactive /
  product messages to text via `businessText`.
- The worker **throws almost all of it away**: `ingest/index.ts` keeps
  `media.path` and drops mime, filename, size, sha256.
- Nothing in the app ever *reads* the media. That is the actual gap.

---

## 1. `protocol.Media` — additive fields

```go
type Media struct {
	Path     string `json:"path"`
	Mime     string `json:"mime"`
	Filename string `json:"filename"`
	Size     int64  `json:"size"`
	SHA256   string `json:"sha256"`

	// new — all optional, omitempty
	ThumbPath string `json:"thumb_path,omitempty"` // JPEGThumbnail written next to Path
	Width     int    `json:"width,omitempty"`
	Height    int    `json:"height,omitempty"`
	Seconds   int    `json:"seconds,omitempty"`    // audio + video duration
	Pages     int    `json:"pages,omitempty"`      // document page count
	Caption   string `json:"caption,omitempty"`
	Voice     bool   `json:"voice,omitempty"`      // PTT / voice note
	Animated  bool   `json:"animated,omitempty"`   // animated sticker or gif-playback video
}
```

`ThumbPath` is written as `<mediaDir>/<chat>/<msgID>.thumb.jpg` from the
proto's `JPEGThumbnail` bytes. It is the only frame we can get from a video
without shipping ffmpeg, and it is what the media reader looks at for video.

## 2. `protocol.Event` — additive fields

```go
	EditOfExternalID   string   `json:"edit_of_external_id,omitempty"`
	RevokeOfExternalID string   `json:"revoke_of_external_id,omitempty"`
	IsForwarded        bool     `json:"is_forwarded,omitempty"`
	MentionedExtIDs    []string `json:"mentioned_ext_ids,omitempty"`
```

Both `*OfExternalID` use the same `<canonicalChatJID>/<stanzaID>` shape as
`external_id`, so they join directly against `events.external_id`.

## 3. `protocol.Kind` — new values

Added: `poll`, `poll_vote`, `live_location`, `call`.
Existing values are unchanged. The TypeScript `EventKind` union in
`worker/src/adapters/types.ts` must gain exactly these four.

## 4. Migration `0008_media`

```sql
ALTER TABLE events ADD COLUMN media_mime TEXT;
ALTER TABLE events ADD COLUMN media_filename TEXT;
ALTER TABLE events ADD COLUMN media_size INTEGER;
ALTER TABLE events ADD COLUMN media_sha256 TEXT;
ALTER TABLE events ADD COLUMN media_thumb_path TEXT;
ALTER TABLE events ADD COLUMN media_seconds INTEGER;
ALTER TABLE events ADD COLUMN media_meta_json TEXT;   -- width/height/pages/voice/animated/caption
ALTER TABLE events ADD COLUMN media_description TEXT;
ALTER TABLE events ADD COLUMN media_desc_status TEXT; -- pending|done|skipped|unsupported|error
ALTER TABLE events ADD COLUMN media_desc_model TEXT;
ALTER TABLE events ADD COLUMN media_desc_ts TEXT;
ALTER TABLE events ADD COLUMN media_desc_error TEXT;
ALTER TABLE events ADD COLUMN edited_at TEXT;
ALTER TABLE events ADD COLUMN revoked_at TEXT;
ALTER TABLE events ADD COLUMN is_forwarded INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_events_desc_status ON events(media_desc_status, ts);
```

`events_fts` is rebuilt as a two-column external-content table over
`(text, media_description)` so a described image is findable by grounded chat.
The `events_ai` / `events_ad` / `events_au` triggers are recreated to match,
and `events_au` must fire on a `media_description` update, not only on `text`.

## 5. Edit and revoke

Today an edit inserts a **second** row and a revoke inserts an empty `revoked`
row; the original is never touched. Both are wrong.

- `edit_of_external_id` set → `UPDATE events SET text=?, edited_at=? WHERE
  source_id=? AND external_id=?`, and the edit event itself is not inserted.
  If the target row does not exist yet (out-of-order history sync) fall back to
  inserting the edit as a normal row.
- `revoke_of_external_id` set → `UPDATE events SET revoked_at=?, text='',
  media_path=NULL WHERE …`; the tombstone event is not inserted.

## 6. Reactions

Already emitted, already folded into the message stream by
`collapseReactions`. Two real gaps to close:

- `EncReactionMessage` (community / encrypted reactions) is unhandled.
- Reaction **removal** arrives as a reaction with empty text and must delete
  the stored reaction rather than record an empty one.

## 7. Reply-to

`messageContextInfo` checks 13 message types. Replies carried on
PollCreation, Album, GroupInvite, Order, Event, Ptv, Comment or the payment
types silently lose `reply_to`. Extend it to cover every type that has a
`ContextInfo`.

## 8. Media reading

Model roles gain `media`, defaulting to `claude-haiku-4-5-20251001`.

| Media | How it is read |
|---|---|
| image, sticker | Claude CLI `Read` on the file — native vision |
| video, PTV | `Read` on `thumb_path` (one frame) + caption + duration |
| document — pdf, txt, md, csv, json | `Read` on the file |
| document — other (docx, xlsx, zip…) | not read; filename + mime recorded |
| audio, voice note | not read; duration + "voice note" recorded |

Honest limits: video is one frame, not the whole clip. Audio is never
transcribed — the CLI adapter has no speech path. Both are recorded as
`unsupported`, never as a fake description.
