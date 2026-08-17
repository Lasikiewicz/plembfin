# Settings Layout Defaults

These are the default visual and structural rules for Plembfin settings pages.
The Sync Tools section is the reference implementation for the primary settings
card shell, with Sync Tuning, Sync Issues, and Sync History sharing the exact same
layout system, spacing, and styling rules.

## Page structure

Each settings page uses this canonical DOM hierarchy:

```html
<div class="settings-pane">
  <div class="settings-row" data-sub-panel="[panel-id]">
    <div class="settings-row-main">
      <article class="glass-panel p-section settings-card tool-section-card">
        <div class="section-heading sync-heading sync-static-heading">
          <div class="sync-heading-title">
            <p style="margin: 0;">[Title]</p>
            <!-- Optional status pill -->
            <span class="status-pill status-muted">Ready</span>
          </div>
          <span>[Description / Subtitle]</span>
        </div>
        <div class="media-force-sync-options sync-tools-content">
          <!-- Content rows / forms / action items -->
        </div>
      </article>
    </div>
    <div class="settings-row-help">
      <article class="glass-panel p-section settings-card">
        <div class="section-heading">
          <p>[Help Title]</p>
          <span>[Help Subtitle]</span>
        </div>
        <!-- Help sections -->
      </article>
    </div>
  </div>
</div>
```

The main column (`.settings-row-main`) is the primary working area (~2.2fr flex ratio). The help column (`.settings-row-help`) explains the working area (~1fr flex ratio, ~320px fixed reference) and collapses below `900px`.

This layout standard applies across all settings panels: Account, Media Servers, Seerr, Webhooks, Metadata Providers, Refresh Metadata, System Integrity, Trakt, Database Repairs, Rebuilds, Backups, Restore, Sync Tuning, Sync Tools, Sync Issues, Sync History, Server Logs, Changelog, and Image Cache.

## Main settings card

The primary card follows the canonical Sync Tools shell:

- Use a full-width `<article class="glass-panel p-section settings-card tool-section-card">` inside `.settings-row-main`.
- Remove outer card padding with `padding: 0 !important`.
- Use `gap: 0 !important` on the outer card so the heading and content form one continuous panel.
- Use `overflow: hidden` so the header border and rounded corners stay clean.
- Use `border: 1px solid var(--line-strong)` and `background: var(--panel)` for the outer card surface.
- Use `border-radius: var(--radius)` (8px default).

## Card heading

The first direct child is the section heading:

- Use `<div class="section-heading sync-heading sync-static-heading">`.
- Group the title and optional status pill on the left inside `<div class="sync-heading-title">`.
- Keep the supporting description text `<span>` on the right.
- Use `padding: var(--space-3) !important` (16px / `1rem`).
- Use `margin: 0 !important` and a bottom border of `1px solid var(--line) !important`.
- Title text uses `<p style="margin: 0;">` with `font-weight: 700` / bold styling.
- Supporting subtitle `<span>` uses `var(--muted)`, `0.78rem` (`font-weight: 500`), and stays right-aligned on wide screens.
- Accordion header toggles (e.g. Sync History) use `<button class="section-heading sync-heading sync-static-heading accordion-header" type="button">` with `background: transparent; border: none; width: 100%; cursor: pointer;`.

## Card content

Every content wrapper immediately following the heading follows these rules:

- Use `<div class="media-force-sync-options sync-tools-content">`.
- Use `padding: var(--space-3) !important` (16px).
- Spacing between child rows uses `gap: var(--space-2) !important` (12px / `0.75rem`).
- Content elements have `margin-top: 0 !important` to avoid doubling the flex gap.

## Action rows, fields, and controls

Action rows, tuning fields, issue items, match reports, and history cards use the standard Sync Tools treatment:

- Use a full border of `1px solid var(--line)`.
- Use `border-radius: var(--radius)` (8px) and `background: var(--panel-2)`.
- Use `padding: var(--space-3)` (16px).
- Provide smooth hover and focus-within states:
  - `:hover` and `:focus-within` change border to `var(--blue)` and background to `var(--panel-3)` with `transition: border-color 160ms ease, background 160ms ease`.
- Keep descriptions left-aligned and let them use the available width before wrapping.

### Field Layout & Multi-line Help Formatting (Sync Tuning)

- Settings input fields (e.g. Sync Tuning) use a 2-column CSS Grid:
  - `display: grid; grid-template-columns: minmax(0, 1fr) minmax(10rem, 13rem); align-items: center; gap: var(--space-3);`
  - Below `760px`, collapse to a single column (`grid-template-columns: 1fr`).
- **Field Title**: `color: var(--text)`, `font-weight: 700`.
- **Field Help Text**: Multi-line help formatting uses explicit `<br>` line breaks separating the description from default value and valid range, with `helpIsHtml: true`:
  ```html
  <span class="settings-field-help">
    [Description].<br>
    Default: [default value]. Valid range: [min]-[max].
  </span>
  ```
  - Color: `var(--muted)`, `font-size: inherit`, `line-height: 1.45`, `max-width: none`.

### Buttons

- Buttons (`.sync-tool-button`, `.button-primary`, `.button-ghost`, `.sync-action-btn`):
  - Height: `min-height: 2.05rem !important` (~33px).
  - Padding: `0.45rem 0.72rem !important`.
  - Typography: `font-size: 0.78rem !important`, `font-weight: 800 !important`, `letter-spacing: 0 !important`.
  - Border Radius: `4px !important`.
  - Box Shadow: `none !important`.
- **Primary Actions**: Use `.button-primary` with blue accent.
- **Cancel / Stop Actions**: Use `.sync-tools-cancel-button` or `.button-danger` with red OKLCH tinting:
  - Border: `color-mix(in oklch, var(--red) 55%, var(--line-strong))`
  - Background: `color-mix(in oklch, var(--red) 14%, var(--panel-2))`
  - Color: `var(--red)`

## Spacing defaults

- `.settings-pane` vertical gap between stacked rows: `var(--space-5)` (24px).
- `.settings-row` column gap: `var(--space-3)` (16px).
- `.settings-row-main` and `.settings-row-help` internal stack gap: `var(--space-2)` (12px).
- Main card heading and content padding: `var(--space-3)` (16px).
- Related action rows & fields gap: `var(--space-2)` (12px).

## Responsive behavior

- At widths below `900px`, stack `.settings-row-main` above `.settings-row-help` at full width.
- At widths below `760px`:
  - Section headings align vertically (`flex-direction: column`, `align-items: flex-start`), subtitle text aligns left.
  - Action buttons stack (`flex-direction: column`, `width: 100%`).
  - Grid rows (target rows, tuning fields) collapse to a single column (`grid-template-columns: 1fr`).
- Preserve the same heading, border, background, and padding hierarchy in both dark and light themes.

## Implementation rule

When adding or updating a settings page, use the shared main-card shell (`article.glass-panel.p-section.settings-card.tool-section-card`) and the Sync Tools structure first. Add a component-specific rule only when the content cannot fit the standard heading/content/action-row pattern, and document the exception beside the component styles.
