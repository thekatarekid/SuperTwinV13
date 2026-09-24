import { ATTRIBUTES, type AttributeKey, type Selection } from "../../shared/options.ts";

interface Props {
  photo: string;
  selection: Selection;
  name: string;
  demo: boolean;
  local: boolean;
  providerLabel: string;
  onChange: (sel: Selection) => void;
  onName: (name: string) => void;
  onRetake: () => void;
  onCreate: () => void;
}

export function Customize({ photo, selection, name, demo, local, providerLabel, onChange, onName, onRetake, onCreate }: Props) {
  const toggle = (key: AttributeKey, id: string, max: number) => {
    const cur = selection[key];
    let next: string[];
    if (max === 1) next = [id];
    else if (cur.includes(id)) next = cur.filter((x) => x !== id);
    else next = [...cur, id].slice(-max); // keep the newest picks
    onChange({ ...selection, [key]: next });
  };

  return (
    <section className="card customize">
      <h2>2 · Design your hero</h2>
      <div className="face-row">
        <img className="face-thumb" src={photo} alt="Your face" />
        <div>
          <label className="name">
            Hero name
            <input value={name} maxLength={20} placeholder="Captain You" onChange={(e) => onName(e.target.value)} />
          </label>
          <button className="link" onClick={onRetake}>
            Retake photo
          </button>
        </div>
      </div>

      {ATTRIBUTES.map((attr) => (
        <fieldset key={attr.key} className="attr">
          <legend>
            {attr.label}
            {attr.max > 1 && <span className="muted"> · pick up to {attr.max}</span>}
          </legend>
          <div className="chips">
            {attr.choices.map((c) => {
              const on = selection[attr.key].includes(c.id);
              return (
                <button
                  key={c.id}
                  className={on ? "chip on" : "chip"}
                  aria-pressed={on}
                  onClick={() => toggle(attr.key, c.id, attr.max)}
                >
                  <span aria-hidden>{c.emoji}</span> {c.label}
                </button>
              );
            })}
          </div>
        </fieldset>
      ))}

      <button className="btn primary big" onClick={onCreate}>
        ✨ Create my hero
      </button>
      <p className="muted small">
        {local
          ? "Made on your Mac with FLUX.2 Klein — free and private; your photo never leaves this computer. Takes about 1–3 minutes."
          : demo
          ? "Demo mode: no API key yet, so you'll get a drawn placeholder hero. Run `npm run setup:local` (free, on a Mac) or add a Pollinations key to use your face — see README."
          : `Your cropped photo is sent once to ${providerLabel} to draw your hero. It isn't stored by this app.`}
      </p>
    </section>
  );
}
