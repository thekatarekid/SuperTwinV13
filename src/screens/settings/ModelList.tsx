// ===========================================================================
// A model registry as a LIST YOU CAN ACT ON (defects 5b and 7).
//
// Both registries — the retrieval encoders under Intelligence and the whisper
// models under Enrichment — used to be dead ends. The encoders were four lines
// of text with sizes and no controls; whisper was a bare dropdown that let you
// select a 3 GB model that was not on the machine and gave you no way to see
// what was, or to reclaim the space. Both worker APIs have had download,
// cancel and delete the whole time; nothing called them.
//
// So this is one component, used twice. It answers, per row, the four
// questions either registry can be asked:
//
//   is it here?      present + the bytes actually on disk, not the catalogue size
//   is it in use?    the active/in-use marker, and why it therefore cannot be deleted
//   can I get it?    Download, with live progress and a Cancel that is an answer
//   can I drop it?   Delete, except for what ships inside the signed app
//
// A failed download stays on its row with the reason the server gave. The one
// thing this must never do is show a row that looks the same whether the
// action worked or not.
// ===========================================================================

export interface ModelRowChip {
  text: string;
  accent?: boolean;
}

export interface ModelRowDownload {
  status: "downloading" | "error";
  receivedBytes: number;
  totalBytes: number | null;
  error: string | null;
  /** Multi-file fetches name the file in flight. */
  file?: string;
}

export interface ModelRowView {
  id: string;
  label: string;
  /** One line of what choosing it buys. */
  note?: string;
  /** Full size of the model, from the catalogue. */
  bytes: number;
  /** What is on disk right now. Null when nothing is. */
  bytesOnDisk: number | null;
  present: boolean;
  /** The one in use: never deletable, and marked. */
  active: boolean;
  /** Ships inside the .app: nothing to fetch, nothing that may be deleted. */
  bundled: boolean;
  chips: ModelRowChip[];
  download: ModelRowDownload | null;
}

export interface ModelListProps {
  rows: ModelRowView[];
  /** The word this list uses for "in use": "active" for encoders, "in use". */
  activeWord: string;
  onDownload: (id: string) => void;
  onCancel: (id: string) => void;
  onDelete: (id: string) => void;
  /** Omitted when a row cannot be switched to from here. */
  onActivate?: (id: string) => void;
  /** The last refusal or failure from the server, shown above the list. */
  error?: string | null;
  /** Where the files live, so "reclaim space" is an actionable sentence. */
  dir?: string | null;
}

/** Bytes → "129 MB" / "1.6 GB". Sizes here span 35 KB to 3 GB. */
export function size(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
  if (bytes >= 1_048_576) return `${Math.round(bytes / 1_048_576)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 12,
  padding: "8px 0",
  borderTop: "1px solid var(--line, rgba(128,128,128,0.2))",
};

export function ModelList(props: ModelListProps): JSX.Element {
  const { rows, activeWord, onDownload, onCancel, onDelete, onActivate } = props;
  return (
    <div>
      {props.error ? (
        <p className="meta" role="alert" style={{ color: "var(--danger, #c0392b)" }}>
          {props.error}
        </p>
      ) : null}
      {rows.map((m) => {
        const busy = m.download?.status === "downloading";
        const failed = m.download?.status === "error";
        return (
          <div key={m.id} style={rowStyle} data-model-row={m.id}>
            <span style={{ minWidth: 0 }}>
              <span>
                {m.label}{" "}
                {m.chips.map((c) => (
                  <span key={c.text}>
                    <span className={c.accent ? "chip accent" : "chip"}>{c.text}</span>{" "}
                  </span>
                ))}
              </span>
              <span className="meta" style={{ display: "block" }}>
                {m.present
                  ? `${size(m.bytesOnDisk ?? m.bytes)} on disk`
                  : `${size(m.bytes)} download`}
                {m.note ? ` · ${m.note}` : ""}
              </span>
              {busy ? (
                <span className="meta" style={{ display: "block" }} role="status">
                  downloading {size(m.download!.receivedBytes)}
                  {m.download!.totalBytes
                    ? ` of ${size(m.download!.totalBytes)}`
                    : ""}
                  {m.download!.file ? ` · ${m.download!.file}` : ""}
                </span>
              ) : null}
              {failed ? (
                // The reason, on the row, in the words the server used. A
                // download that failed and looks idle is the worst of both.
                <span
                  className="meta"
                  role="alert"
                  style={{ display: "block", color: "var(--danger, #c0392b)" }}
                >
                  download failed — {m.download!.error ?? "unknown error"}
                </span>
              ) : null}
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              {busy ? (
                <button type="button" onClick={() => onCancel(m.id)}>
                  Cancel
                </button>
              ) : m.present ? (
                <>
                  {onActivate && !m.active ? (
                    <button type="button" onClick={() => onActivate(m.id)}>
                      Use
                    </button>
                  ) : null}
                  {m.bundled ? (
                    <span className="meta">in the app</span>
                  ) : m.active ? (
                    <span className="meta">{activeWord}</span>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Delete ${m.label}`}
                      onClick={() => onDelete(m.id)}
                    >
                      Delete
                    </button>
                  )}
                </>
              ) : (
                <button
                  type="button"
                  aria-label={`Download ${m.label}`}
                  onClick={() => onDownload(m.id)}
                >
                  {failed ? "Retry" : "Download"}
                </button>
              )}
            </span>
          </div>
        );
      })}
      {props.dir ? <p className="meta">downloads live in {props.dir}</p> : null}
    </div>
  );
}
