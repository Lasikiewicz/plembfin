# Plembfin — Agent Rules

## Settings Layout Spacing Standards

These are the **canonical spacing values** for the settings UI. Do not change them without explicit user instruction.

### Token Reference (`styles.css` `:root`)
| Variable | Value | Pixels |
|---|---|---|
| `--space-1` | 0.25rem | 4px |
| `--space-2` | 0.5rem | 8px |
| `--space-3` | 0.75rem | 12px |
| `--space-4` | 1rem | 16px |
| `--space-5` | 1.5rem | 24px |
| `--space-6` | 2rem | 32px |

### Canonical Settings Gaps

All of the following must stay consistent — do not change one without updating the others.

| Element | Property | Value | Notes |
|---|---|---|---|
| `.app-shell` | `gap` | `var(--space-3)` | Gap between topbar and view content |
| `.page-topbar + .view-panel` | `padding-top` | `var(--space-2)` | Extra breathing room below topbar |
| `.settings-content` | `gap` | `1.5rem` | Gap between settings panes when stacked |
| `.settings-pane` | `gap` | `1.5rem` | Gap between `.settings-row` elements |
| `.settings-row` | `gap` | `var(--space-3)` | Gap between left (main) and right (help) columns — **must equal the topbar gap** |
| `.settings-row-main` | `gap` | `1.5rem` | Gap between stacked cards inside main column |
| `.settings-row-help` | `gap` | `1.5rem` | Gap between stacked cards inside help column |
| `.settings-card` | `padding` | `1.5rem` | Internal card padding (all sides) |

### Rules

1. **The `.settings-row` horizontal gap must always equal the `app-shell` grid gap** (`var(--space-3)`). This ensures the gap between left and right panels matches the gap between the topbar and content.
2. **All vertical card-to-card gaps use `1.5rem`** — `.settings-content`, `.settings-pane`, `.settings-row-main`, `.settings-row-help` all share this value.
3. **Card internal padding is `1.5rem` on all sides**, set via `padding: 1.5rem !important` on `.settings-card` (the `!important` exists to override the base `.glass-panel` / `.p-section` rules).
4. **Never add per-panel margin or gap overrides** (e.g. `margin-top` on a specific `settings-pane[data-settings-panel]` selector). All spacing must come from the flex gap alone.
5. **Do not merge `.app-shell` into a shared selector with `.view-panel`** — `.app-shell` needs `gap: var(--space-3)` while `.view-panel` needs `gap: 0`. Merging them collapses the topbar into the page content.

### Settings Navigation Rules

6. **All settings navigation links** (sidebar buttons, overview link rows, section-select dropdown options) must navigate to the **parent group path** (e.g. `/settings/media-servers-group`), never to a child `#hash` anchor. Hash anchors cause the page to auto-scroll past the top padding.
7. **`focusSettingsRoute`** must scroll the container to the top (`window.scrollTo(0, 0)`) on every navigation, not `scrollIntoView` to a child element.
