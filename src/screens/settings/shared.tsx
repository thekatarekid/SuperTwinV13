// ===========================================================================
// Settings — pieces every subtab panel shares.
//
// The panels used to live in one 800-line Settings.tsx. They are one file per
// subtab now (the shell only knows the list), so this holds the handful of
// bits they all reach for: the label/control row, the labelled checkbox, and
// the MB formatter.
// ===========================================================================

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
