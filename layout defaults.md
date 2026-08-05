# Settings Layout Defaults

These are the default visual and structural rules for Plembfin settings pages.
The Sync Tools section is the reference implementation for the primary settings
card shell.

## Page structure

Each settings page uses this hierarchy:

```text
.settings-pane
└── .settings-row
    ├── .settings-row-main
    │   └── primary settings card
    │       ├── .section-heading
    │       └── content wrapper
    └── .settings-row-help
        └── help card
```

The main column is the working area. The help column explains the working area
and may be shorter or collapsed when the main content is taller.

The shared default applies to all settings panels: Account, Media Servers,
Seerr, Webhooks, Metadata Providers, Refresh Metadata, System Integrity,
Trakt Importer, Database Repairs, Rebuilds, Backups, Restore, Sync Tuning,
Sync Tools, Sync Issues, Sync History, Server Logs, Changelog, and Image Cache.

## Main settings card

The primary card follows the Sync Tools shell:

- Use a full-width `.glass-panel p-section settings-card` (or the equivalent
  `sync-panel` / `logs-panel` class) inside `.settings-row-main`.
- Remove outer card padding with `padding: 0`.
- Use `gap: 0` on the outer card so the heading and content form one continuous
  panel.
- Use `overflow: hidden` so the header border and rounded corners stay clean.
- Use `border-color: var(--line-strong)` and `background: var(--panel)` for the
  outer card surface.
- Keep the shared `border-radius: var(--radius)`.

## Card heading

The first direct child is the card heading:

- Use `.section-heading sync-static-heading` for a non-collapsible heading.
- Keep the title on the left and the supporting description on the right.
- Use `padding: var(--space-3)`.
- Use `margin: 0` and a bottom border of `1px solid var(--line)`.
- Keep titles at the shared settings heading size and weight.
- Supporting text uses `var(--muted)`, approximately `0.78rem`, and stays
  right-aligned on wide screens.
- Headings must remain readable when the description wraps; do not use fixed
  heights.

## Card content

Every direct child after the heading is a content wrapper:

- Use `padding: var(--space-3)`.
- Remove inherited top margins so spacing comes from the card layout.
- Use `gap: var(--space-2)` for compact, related controls.
- Keep larger separations between distinct content groups at
  `var(--space-3)` or `var(--space-5)`.
- Do not add per-page margin hacks to compensate for the shared shell.

## Action rows and controls

Action rows inside a settings card should use the Sync Tools treatment:

- Use a full border of `1px solid var(--line)`.
- Use `border-radius: var(--radius)` and `background: var(--panel-2)`.
- Use `padding: var(--space-3)`.
- Keep descriptions left-aligned and let them use the available width before
  wrapping.
- Align selects and action buttons to the right on wide screens.
- Static settings fields, such as Sync Tuning, use the same bordered card rows:
  descriptive content on the left and the control on the right.
- Keep field descriptions visible by default; routine settings guidance should
  not be hidden inside collapsible accordions.
- Keep short settings actions and forms permanently visible.
- Reserve collapsible boxes for genuinely long lists, result sets, logs, or
  detailed instructions that would otherwise make the page unwieldy.
- Tool panels that need progressive disclosure still use the same bordered row,
  spacing, hover, focus, heading, and description treatment as Sync Tools.
- Use the shared settings button height, padding, `0.78rem` text size, and
  bold weight.
- Use the primary blue treatment for normal actions.
- Use the red treatment only for Cancel or Stop actions, with sufficient text
  contrast in both themes.
- Provide hover and keyboard-focus states without moving the layout.

Service cards, account fields, backup destinations, log filters, and metadata
cards use the same bordered `var(--panel-2)` row treatment as action rows.
They use compact `var(--space-2)` sibling spacing and do not translate on
hover.

## Spacing defaults

- `.settings-pane` between stacked rows: `var(--space-5)`.
- `.settings-row` column gap: `var(--space-3)`.
- `.settings-row-main` and `.settings-row-help` internal stack gap:
  `var(--space-2)`.
- Main card heading and content padding: `var(--space-3)`.
- Related action rows: `var(--space-2)` gap.

Use the existing spacing tokens rather than introducing one-off pixel values.

## Responsive behavior

- At widths below `900px`, stack `.settings-row-main` above
  `.settings-row-help` at full width.
- Action rows should switch to a single column when their controls no longer
  fit comfortably.
- Keep buttons and fields usable on touch screens; do not hide required
  actions.
- Preserve the same heading, border, background, and padding hierarchy in both
  dark and light themes.

Short forms, actions, and endpoint/configuration details stay open and visible
by default. Only long lists, result sets, logs, previews, restore inventories,
or detailed setup instructions use a collapsible disclosure.

## Implementation rule

When adding a new settings page, use the shared main-card selectors and the
Sync Tools structure first. Add a component-specific rule only when the content
cannot fit the standard heading/content/action-row pattern, and document the
exception beside the component styles.
