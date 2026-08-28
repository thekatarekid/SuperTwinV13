// Timeline / Library / Settings stubs — build P1.7. The pill nav needs the
// four tabs (spec §14.1.3); these screens fill out in P2.4 (Library),
// P4 (Timeline polish) and the Settings items land with their lanes.

export function Timeline(): JSX.Element {
  return (
    <div className="stub">
      <h1>Timeline</h1>
      <p>The event log rendered — arrives with the capture lanes (spec §14.3).</p>
    </div>
  );
}

export function Library(): JSX.Element {
  return (
    <div className="stub">
      <h1>Library</h1>
      <p>Per-source capture + trust controls — arrives with P2.4 (spec §14.3.2).</p>
    </div>
  );
}

export function Settings(): JSX.Element {
  return (
    <div className="stub">
      <h1>Settings</h1>
      <p>General · Capture &amp; Privacy · Sources · Intelligence · Enrichment · Assist · Runs · Data (spec §14.9).</p>
    </div>
  );
}
