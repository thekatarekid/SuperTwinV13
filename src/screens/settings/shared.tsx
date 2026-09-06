// ===========================================================================
// Settings — pieces every subtab panel shares.
//
// The panels used to live in one 800-line Settings.tsx. They are one file per
// subtab now (the shell only knows the list), so this holds the handful of
// bits they all reach for: the label/control row, the labelled checkbox, and
// the MB formatter.
// ===========================================================================

/**
 * The line a panel shows when a save did not land (W3). A switch that springs
 * back with nothing said is the same lie as a spinner that never resolves, so
 * every panel's `save` funnels its failure here instead of `.catch(() => {})`.
 */
export function SaveError(props: { error: string | null; onDismiss: () => void }): JSX.Element | null {
  if (props.error === null) return null;
  return (
    <p className="error" role="alert">
      {props.error}{" "}
      <button type="button" className="linklike" onClick={props.onDismiss}>
        dismiss
      </button>
    </p>
  );
}

export const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "4px 0",
};

/** Bytes → "12.3 MB", the only size format Settings shows. */
export function mb(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export function Toggle(props: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <label style={rowStyle}>
      <span>{props.label}</span>
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
      />
    </label>
  );
}
