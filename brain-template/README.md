# Brain template

Skeleton for the SuperTwin "brain" — a plain-markdown wiki that holds all
**knowledge** (SQLite holds operational truth; git tracks history). At runtime
this template is copied to `~/SuperTwin/brain/` and git-initialized. Phase 0
only scaffolds the directory layout; the extraction engine (Phase 2+) populates
the files.

## Layout

```
brain/
  spaces/     one dir per space — spaces/<slug>/space.md + log.md
              (goals, milestones, latest update, state, open questions)
  people/     CRM — people/<name>.md
              (relationship, context, shared spaces, commitments, last interaction)
  workflows/  workflows/<slug>.md — multi-step processes the user runs
              (trigger, steps, tools)
  habits/     habits/<slug>.md — recurring behaviors + cadence
              (confirmed vs candidate status)
  me/         me/preferences.md, me/goals.md, me/procedures/*.md
              (feedback-derived rules and personal defaults)
```

## Conventions

- `[[wikilinks]]` between files express relationships (the relationship layer —
  not a graph DB).
- Every fact carries an inline source link to the originating event, e.g.
  `evt:<id>`.
- Frontmatter (`type`, `status`, `confidence`, `updated_at`) keeps files
  machine-scannable.
- A Workflow/Habit file requires ≥2–3 observed repetitions or an explicit user
  statement before it is promoted from `status: candidate`.
