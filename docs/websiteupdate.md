# Website update workflow

When a website update is requested, carry out the following workflow:

1. Inspect the current website documentation and its verification markers to determine which application baseline it covers. Treat the current website as verified against `v0.14.0.5` unless the website records a newer baseline or a newer baseline is explicitly provided. Review the application and changelog for all changes after that baseline before editing.
2. Start the local plembfin server and the local website preview from the `website` folder, and record the local URLs and relevant environment details.
3. Review the application source, changelog, release data, and existing website content for all changes after the discovered verification baseline.
4. Update the website documentation and supporting content so that it accurately reflects the current product, including names, descriptions, routes, controls, behavior, and links. Do not describe removed pages, removed controls, or historical defects as current behavior. If a repair is still useful, put it in a clearly separate troubleshooting or repair note and describe the current command or setting.
5. Use route-only examples for in-app detail pages, such as `/tvshow/tvdb/<id>-<slug>/` or `/movie/tmdb/<id>-<slug>`. Keep `localhost` or other hosts only in setup instructions that explicitly explain how to start or open the local application.
6. Link every reference to another setting, page, feature, or repair action to its corresponding website section. Keep articles compact: use short paragraphs, bullets, and focused subsections instead of large blocks of prose.
7. When an existing item has changed, inspect the affected page in the local preview and verify whether its rendered appearance has changed. Use the local environment details to check layout, typography, spacing, colors, controls, states, and responsive behavior as applicable. Every screenshot and caption must match the section it illustrates. Use one genuinely full detail-page capture for a page overview, and use focused captures only for the control or section being explained. Remove a redundant image at the very top when the next section already shows the same view; do not replace that with a cropped or first-viewport image when the page overview is expected to show the complete page.
8. Keep page-specific guidance current: show the separate **Spoilers on** and **Spoilers off** states with matching images, document **Force Sync** with both its title-level menu and the broader Sync Tools settings, and give each Trailers & Clips, Reviews, Related Shows, and Appearance section an image that actually depicts that section when a useful capture exists. Provider Reviews and public/example Custom Lists are approved unblurred content; do not blur them solely because they appear in those sections. If a screenshot is too large, blurry, or privacy-redacted in the wrong place, recapture it at a useful size and preserve allowed public media facts such as watch dates and ratings.
9. Run `npm run captures:inventory` to enumerate every image referenced by the website and report added, changed, removed, missing, or unreferenced captures. Run `npm run check:duplicates` to catch repeated figures inside one article. Use the generated manifest to review the whole capture set together rather than collecting images one by one.
   For a scrollable detail page, use `npm run captures:compose -- --prefix=<temporary-capture-prefix> --positions=0,<middle-scroll>,<max-scroll> --page-height=<page-height> --content-x=<sidebar-width> --fixed-top=<sticky-header-height> --output=<final-capture-path>`. Add `--redact=x,y,width,height` when a reviewed region must be blurred in the composed image.
10. Treat image privacy as a hard release gate. Every image published by the website, including raster captures and SVG assets, must have an explicit entry in `website/capture-privacy.json`. Before committing an image, inspect it for user-identifiable information, including usernames, email addresses, custom server or library names, hostnames, IP addresses, URLs, tokens, account IDs, and private media labels. Blur such content in the image itself, record the redaction in the privacy manifest, and never publish the raw capture. Provider Reviews and public/example Custom Lists are explicit approved exceptions and do not need blurring; keep them unblurred unless the capture also contains unrelated identifying data. Public media titles, cast names, provider ratings, and watch dates are not user-identifiable by themselves and must not be blurred unnecessarily.
11. Check information architecture while updating: removed landing pages must not remain in the sidebar, page navigation, feature outlines, or cross-links; dedicated Watchlist, Ratings, and Custom Lists pages should be linked directly. Dashboard documentation must describe resume and part-watched items inside **Up Next**, not as a separate current section.
12. Keep the written guidance compact and present-tense. Use a separate repair note for a still-useful current repair, such as “If the actual episode names are missing, run **Settings → Tools → Database Repairs → Restore Missing Episode Names**”; do not describe an old defect, coordinate-only record, or removed workflow as current behavior. Link every reference to another setting, page, feature, or repair action.
13. Run the website checks/build after editing, including the capture inventory, duplicate-figure check, and privacy check. Resolve relevant failures, and report the files changed, validation performed, local preview URL, visual findings, and any remaining content discrepancies.

## Issues found during the current update and how to prevent them

- **Baseline drift:** the website was marked against an older release while the app was
  already on `0.15.0`. Discover the marker first, compare the source and changelog after
  that marker, and update every changed page's `sourceVersion` together.
- **Duplicate documentation:** an all-features page and a combined library page repeated
  the focused page guides. Keep one canonical page per task, use the [Guides](/docs/guides/)
  landing page as an index, and link to the owner instead of copying procedures.
- **Guides versus Getting started:** Guides is the top-level map for the documentation
  section and should explain how the canonical pages fit together. Getting started should
  stay limited to installation, claiming, Guided Setup, and the first health check; do not
  copy onboarding stages or create a second application-map article.
- **Onboarding repeated in Getting started:** connecting the first media server belongs to
  the in-app Guided Setup flow. Keep Getting started focused on installation, claiming,
  Guided Setup, and post-setup checks; link to [Settings → Media servers](/docs/settings/media-servers/)
  for a later connection.
- **Stale UI actions:** the movie-card menu had changed but its screenshot and text listed
  only three actions. Open the current menu in the local app, record every visible action,
  recapture both themes, and update all pages that reuse that asset.
- **Wrong image for the section:** a full-page image, a focused control crop, and an image
  containing a transient error are not interchangeable. Name captures by the section they
  show, compare the screenshot with the heading and caption, and reject a capture if it
  contains an error banner or unrelated state.
- **Over-redaction:** privacy protection is strict, but the blur region must identify an
  actual user identifier or secret. Blur only keys, tokens, account IDs, usernames, email
  addresses, custom server/library names, hostnames, IP addresses, URLs, or private labels.
  Public Reviews, public/example Custom Lists, media titles, cast, provider ratings, and
  watch dates remain visible. If a reviewed capture has none of those identifiers, publish
  it without blur and record it under `safeAssets`.
- **Hostnames in route examples:** in-app route documentation uses paths such as
  `/tvshow/tvdb/<id>-<slug>/`; `localhost` belongs only in setup and local-preview commands.
- **Dense copy:** split long explanations into short paragraphs, bullets, and linked
  subsections. A sentence that points to another page should link directly to that page,
  not reproduce its full guide.
- **Dashboard state confusion:** resume and part-watched items are part of **Up Next**.
  Keep one focused Up Next capture with no provider-error banner and do not document a
  separate current Part Watched section.
- **Missing capture inventory:** run `npm run captures:inventory` after every capture edit,
  crop, deletion, or rename. Review the generated manifest's added, changed, removed,
  missing, and unreferenced lists before the final privacy and build checks.
- **Repeated figures returning:** run `npm run check:duplicates` after restructuring a guide.
  Keep one useful figure per view in an article; use a focused crop for a focused control and
  link to the canonical guide rather than repeating the same screenshot under every related
  subsection.
- **Global search placement:** keep the documentation search control in the shared site
  navbar so it is available from every website page. Submit searches to `/docs/?q=...`, keep
  the results list on the documentation landing page, and verify both empty and populated
  clear states after changing the shared header.
- **Homepage positioning and proof:** the home page should lead with Plembfin as the local
  source of truth—the brain that tracks playback, remembers canonical state, and auto-syncs
  the right answer back to connected services. Keep the main Track → Remember → Auto-sync
  loop visible, then send the broader feature inventory to the top-level `/features/` page.
  Use real captures on the feature page when they clarify a workflow; do not force a screenshot
  into the short overview. Preserve the shared navbar, light/dark theme support, responsive
  layout, keyboard focus states, and reduced-motion behavior. Re-run the local visual pass on
  both routes, in both themes, and at narrow widths before accepting a redesign.
- **Homepage tone and spacing:** avoid generated-looking hero treatments, oversized slogan
  typography, fake dashboards, ambient grids, glows, and excessive whitespace between
  related items. Lead with a real product capture, use plain product language, keep the
  Track → Remember → Auto-sync explanation close to the hero, and use compact spacing so
  the page feels like a maintained product rather than a concept page. Check that the hero
  headline, supporting copy, screenshot, and calls to action all explain the same product
  promise before accepting the visual pass.
- **Homepage must feel like Plembfin:** keep the home page dark-first, compact, media-first,
  and aligned with the app's dashboard language. Use real screens and the existing tokens;
  do not wrap screenshots in decorative boxes, add marketing-only reveal effects, or fill
  every feature with a paragraph. Use short linked rows for secondary features and let the
  actual media UI carry the visual weight. Check the hero, core flow, feature list, and
  product proof at their anchors in both themes before accepting the page.
- **Keep the homepage and feature index separate:** the homepage should explain Plembfin in
  one short overview and one clear Track → Remember → Auto-sync flow. Put the broader feature
  inventory on the top-level `/features/` page, using concise grouped rows and direct links to
  the detailed documentation. Do not turn the homepage into a second documentation index.
- **Product-site visual direction:** when the homepage or Features page changes, review the
  current official [Sonarr](https://sonarr.tv/), [Radarr](https://radarr.video/),
  [Seerr](https://seerr.dev/), and [Plex](https://www.plex.tv/) presentation patterns. Borrow
  the useful structure—screenshot-led product proof, short feature sections, clear actions,
  and media-first rails—but keep Plembfin's own copy, logo, reviewed captures, and UI language.
  Use the existing `--accent`, `--blue`, `--text`, `--soft`, and `--bg` tokens so light mode
  and dark mode retain the Plembfin palette. Do not introduce a purple/gradient palette or copy
  another product's identity. Recheck both routes in both themes after every visual change.
- **Simple landing-page reference rule:** a reference such as [Scrob](https://scrob.app/) may
  be reviewed for high-level communication structure only: one clear promise, one useful
  product view, a short feature overview, and direct links into the docs. Never copy its
  wording, logo, colour treatment, imagery, layout details, or product claims. Rebuild the
  idea with Plembfin's existing tokens, current screenshots, and accurate source-of-truth
  language. Keep the homepage shorter than the Features page; do not turn either page into a
  large hero, a generic AI-style marketing composition, or a second copy of the docs.
- **Landing-page link audit:** every page-specific documentation link on the homepage or
  Features page must include the exact generated section anchor when one exists, such as
  `/docs/dashboard/#up-next` or `/docs/settings/backup/#remote-backups`. After building, check
  each fragment against the matching `dist/docs/.../index.html` heading ID; the normal link
  checker does not replace this fragment-level verification. Shared navbar and footer links
  may intentionally land on the documentation index.
- **Feature-link meaning audit:** an existing anchor is not automatically the right
  destination. Compare each feature title and summary with the content under the target
  heading; use `#security-basics` for hardening guidance, `#pwa-and-local-operation` for
  PWA/local-operation guidance, and `/docs/getting-started/#before-you-install` for the
  self-hosted setup explanation.
- **Homepage backup reminder:** place the backup explanation in or immediately below the
  Track → Remember → Auto-sync rows, not as a detached aside beside the section heading. It
  must make clear that the local archive can be protected with both local backups and
  optional remote backups. Link the two phrases directly to `#local-backups` and
  `#remote-backups` so the distinction cannot be lost in general backup wording.

## Force-to-main website gate

When a user requests **Force to main**, ask immediately, before checking out branches,
previewing the release, staging, or force-pushing:

> Should I run the website update check before this Force to main operation?

If the answer is yes, complete this file end to end: discover the verification baseline,
review changes after it, start the local app and website preview, audit content and images,
check privacy, run the inventory and website checks, and report the local visual findings.
If the answer is no, record that the website check was declined and continue only with the
normal Force to main instructions in [`CLAUDE.md`](../CLAUDE.md). Do not infer the answer.

## Publish plan

The website is a static Astro site in `website/`. The GitHub-to-Cloudflare Pages setup,
including the required `website/` tracking decision, build settings, previews, domain,
secrets, rollback, and verification steps, is documented in
[`docs/website-deployment.md`](website-deployment.md). This update workflow validates the
site locally; it does not push or deploy it unless the user explicitly asks.
