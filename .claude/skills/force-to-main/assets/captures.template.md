# Force to main v<version>: phase B (capture only)

## Instructions

This file is your complete assignment. Take only the images listed below from the
already-running app. Read no other instruction, plan, credential, or website file.
Browser inspection, source/process checks, and executing the supplied capture commands
are allowed. Do not start/stop a server, switch branches, promote, publish, change the
release lock, commit, edit `website/`, or run website inventory/check/build scripts.
Do not change library data or save application settings. Browser-local theme toggles,
navigation, opening the specified menus, and scrolling are allowed.

- App URL: `<app-url>`
- Approved source checkout: `<absolute-candidate-worktree>`
- Expected source commit: `<full-pinned-alpha-hash>`
- Expected served version/channel: `<alpha-version>` / `alpha` (stable promotion is later).
- Server PID and command: `<pid>` / `<recorded-command>`
- Repository: `<absolute-main-checkout>`
- Signed-in collaborative browser tab: `<tab-id>`; if missing, open the app URL and check
  whether the session is available. If login is required, report FAIL; do not find or
  copy credentials into this file or your report.
- Staging folder: `<absolute-run-folder>/captures/`
- Website command working directory: `<absolute-main-checkout>/website/`
- Return line: `Force to main v<version>, phase C: read the run summary.`

Before capturing, verify `git -C '<absolute-candidate-worktree>' rev-parse HEAD` equals
the expected hash and the recorded PID still serves this app. Verify the running build
through `/api/changelog` in the signed-in tab; `current` is the stable base, while
`alphaBuild.version` / `developBuild.version` identifies the installed channel build.
Use `preview_evaluate` with this expression, returning only these safe fields:

```javascript
(async () => {
  const response = await fetch('/api/changelog', { cache: 'no-store' });
  if (!response.ok) return { status: response.status };
  const data = await response.json();
  const normalize = value => {
    const parts = String(value ?? '').replace(/^v/i, '').split('.');
    if (parts.length < 3 || parts.length > 5 || !parts.every(p => /^\d+$/.test(p))) return null;
    while (parts.length > 3 && Number(parts.at(-1)) === 0) parts.pop();
    return parts.join('.');
  };
  const installed = data.channel === 'alpha' ? data.alphaBuild?.version
    : data.channel === 'develop' ? data.developBuild?.version : data.current;
  return { status: response.status, channel: data.channel,
    buildVersion: normalize(installed), stableVersion: normalize(data.current),
    sidebarLabel: document.querySelector('#appVersion')?.textContent?.trim() };
})()
```

Compare `channel` and normalized `buildVersion` with the expected values above.
Record `sidebarLabel` separately: direct navigation to `/settings` can retain the
bundled stable badge (`v<stableVersion>`) even on an alpha/develop server. This known
initial label is allowed only when the API build/channel and source/PID all match;
an unexplained different label fails. Do not change badge text or DOM content.
Inspect only the theme keys and needed DOM data; do not dump storage, cookies,
configuration, or authenticated URLs. On any source/build/channel mismatch or failed
version request, report FAIL for all pending images and stop. Do not repair the server
or capture from another build.

Create the staging directory if needed. All project output files, raw frames, crops,
composites, and `results.md` go there. Browser tools may transfer snapshots into their
own artifact cache; copy those returned PNG paths into staging before processing.
Never copy a capture into `website/` in this phase.

## Capture commands

Use the T3 collaborative preview tools. First call `preview_status` with the recorded
tab ID, then `preview_open` if no automation-capable tab is attached. Use
`preview_navigate`, `preview_resize` (`mode: freeform`, the entry's width/height), and
`preview_snapshot` before interacting. Prefer snapshot-provided locators. Use
`preview_evaluate` for DOM measurements and exact container scroll positions.

For each entry, set the app's own style and mode with `#themeStyleButton` and
`#themeToggleButton` as necessary. Verify Modern has `data-style="modern"` on `<html>`;
Classic has no `data-style`; light has `light-mode` on `<html>` and dark does not.
Wait for the requested state, loaded images, and settled layout. Close unrelated menus,
tooltips, or banners. Do not hide errors or change DOM content to manufacture a state:
if the required view cannot be reached, report FAIL with the reason.

Call `preview_snapshot` with `save: true, includeImage: false` for a viewport PNG;
use its returned `screenshotPath` in PowerShell:

```powershell
Copy-Item -LiteralPath '<returned-screenshotPath>' -Destination '<staging>/<filename>.png'
```

Inspect each saved raw PNG at its original size before cropping or composing; headings
and body text must be legible. If snapshot saving fails or the saved frame is blurred,
inspect the error/image and retry once after reopening the same T3 tab with
`preview_open` at the specified route and rechecking theme, viewport, and scroll state.
If saving or image quality still fails, report FAIL; do not accept an unreadable frame,
claim an unsaved snapshot as a staged image, or switch browser systems.

For a focused crop, save a raw viewport frame in staging and measure the requested
element using `getBoundingClientRect()`. Scale CSS coordinates to PNG pixels if the
snapshot dimensions differ from the viewport. Run this from the website command
directory (Sharp is already installed); supply integer bounds that fit the raw PNG:

```powershell
@'
import sharp from "sharp";
const [input, output, left, top, width, height] = process.argv.slice(2);
await sharp(input).extract({left: Number(left), top: Number(top), width: Number(width), height: Number(height)}).png().toFile(output);
'@ | node --input-type=module - '<staging>/<raw>.png' '<staging>/<final>.png' <left> <top> <width> <height>
```

For a scrolling overview, take three viewport frames, named `<prefix>-0.png`,
`<prefix>-1.png`, `<prefix>-2.png`, at the top, middle, and bottom of the entry's scroll
container. Preload the page by scrolling through it first, then measure again after
images/layout settle. Record actual positions after scrolling; requested offsets may
be clamped. Keep the viewport, theme, and page state identical across the three frames.

The compositor accepts screenshot pixels, not unscaled DOM scroll units. For an app
panel filling the viewport vertically, measure `s = rect.height / clientHeight` and
use `round(scrollTop * s)` for each position and `ceil(scrollHeight * s)` for page height.
Use the content panel's rendered left edge for content-x and the sticky header's
rendered bottom edge for fixed-top; convert these to PNG pixels when needed. If the
scroll panel does not fill the viewport, the entry must specify its crop/offset method.
Confirm each later frame starts before the preceding frame's usable bottom:
`position[i] + fixed-top <= position[i-1] + viewport-PNG-height`. Three frames must
cover the whole page; if they cannot, report FAIL rather than outputting a page with gaps.
From the website command directory run:

```powershell
npm run captures:compose -- --prefix='<staging>/<prefix>' --positions=0,<actual-middle-pixels>,<actual-bottom-pixels> --page-height=<full-height-pixels> --content-x=<sidebar-pixels> --fixed-top=<sticky-header-pixels> --output='<staging>/<final>.png'
```

Inspect every final PNG, including the joins and the last section of a composite.
A first viewport is not a full-page overview. Do not silently return a crop instead
of a requested full page. Restore the initial browser-local style/mode when finished.

## Privacy

Inspect even entries marked "may show a key: no". Visible API keys, tokens, passwords,
and other secrets are forbidden in accepted images. Never reveal a masked field.
If a visible secret is found, report FAIL without transcribing it; keep the raw frame
in staging only and flag it for phase C. If this list supplies a reviewed blur rectangle
for a composite, add `--redact=x,y,width,height` to `captures:compose`, inspect the
result, and record the region. Do not invent additional redactions.

Blur nothing else: usernames, account/server/library names, playlist titles, backup
filenames, account identifiers, provider Reviews, public/example Playlists, media titles,
cast, ratings, and watch dates remain visible. Phase C owns the published privacy manifest.

## Images

### <image-id>: <short-purpose>

- Output filename: `<final-name>.png` (inside staging).
- Website page, section, intended caption: `<page>` / `<section>` / `<caption>`.
- App route: `<exact-url>`.
- Required state and navigation: `<controls, menu/tab, media identity, spoiler state, readiness>`.
- Style / mode: `<Classic-or-Modern>` / `<light-or-dark>`.
- Viewport: `<width>` x `<height>` CSS pixels.
- Framing: `<viewport, focused element selector and bounds, or full scrolling page>`.
- Scroll/composition: `<container, prefix, coverage, offsets, sticky header, scale; or none>`.
- May show a key: `<yes-or-no>`; reviewed blur rectangle: `<none-or-x,y,width,height>`.
- PASS requires: `<visible content and bottom/section checks matching the caption>`.

## Results and handoff

Write `results.md` inside staging; leave this assignment unchanged. Report the source,
PID/version checks and initial/restored theme, then one row per requested image:

| Image | PASS/FAIL | Staged file / dimensions | Actual route, style/mode, scroll/composition | Keys/redactions | Findings |
| --- | --- | --- | --- | --- | --- |

Include failed items and reasons. Distinguish capture success from release approval:
phase C still reviews every image before placement. Return the same table in chat and
the exact return line above, then stop. If there are no images, report that explicitly
and return the line without taking screenshots.
