# Plembfin promotion plan: September 2026

**Status:** staging complete for the current pass. Reddit posts and the DEV article are published; Product Hunt is scheduled for launch.

**Research date:** 2026-09-10

## Executive decision

The best previous Plembfin promotion was the r/jellyfin tester post: 12 upvotes, 17 comments, and roughly 21K Reddit views. Its winning ingredients were a concrete tester request, a real operational problem, technical specificity, honest pre-1.0/back-up language, and active replies. The r/opensource post was the next strongest useful signal at 5 upvotes, 7 comments, and roughly 5.3K views.

The r/jellyfin post should not be repeated there: that community's currently visible rules include **No advertising**. The next Reddit round should be narrower and rule-gated:

1. r/selfhosted's current **New Project Megathread** only.
2. r/homelab only after satisfying its exact software-flair form, AI disclosure, prompt, and karma requirements.
3. One distinct, technically useful r/opensource update, with the `Promotional` flair and generous spacing from the prior post.
4. One or two lower-risk feedback communities: r/SideProject, r/IMadeThis, or r/WebApps. Do not cross-post the same body everywhere on the same day.

In parallel, prepare owned-channel assets for GitHub, Discord, and the Plembfin website. Prepare Product Hunt and Indie Hackers next. Hold Hacker News until there is a genuinely easy-to-try path for people who do not already run a media stack.

## Product positioning to use consistently

Plembfin is the local-first, self-hosted watch-state hub for people who use more than one media server. It keeps a canonical record in local SQLite and reconciles watched state, resume progress, and repeat plays across Plex, Emby, Jellyfin, and Trakt. Its strongest differentiator is explainability: Sync Activity shows source, destination, outcome, reason, retry state, and targeted retry options instead of hiding failures behind a single green or red sync result.

Supporting proof points:

- v1.0.0 was released on 2026-09-09.
- AGPL-3.0 licensed and self-hosted.
- Docker Compose and a GHCR image are documented.
- Data stays on the user's hardware; a backup-first warning is appropriate for early testers.
- Includes Now Playing, history, stats, upcoming episodes, metadata, Seerr integration, and local/optional remote backups.
- Runtime is not dependent on AI. The implementation was heavily AI-assisted, and that must be disclosed where a community asks for it.

Canonical links:

- Website: <https://plembfin.com>
- Repository: <https://github.com/Lasikiewicz/plembfin>
- Documentation: <https://github.com/Lasikiewicz/plembfin/tree/main/docs>
- Reddit community: <https://www.reddit.com/r/plembfin/>
- Discord: <https://discord.gg/7ZmEGKcRC5>

## What the previous promotions taught us

Reddit's view count is a rough platform metric, not unique reach or activation. It is still useful for comparing these posts because they were shown in the same account's post history.

| Post | Community | Result | What to keep/change |
| --- | --- | --- | --- |
| [Looking for testers for my self-hosted media sync project](https://www.reddit.com/r/jellyfin/comments/1vzqrqs/looking_for_testers_for_my_selfhosted_media_sync/) | r/jellyfin | **12 upvotes, 17 comments, ~21K views** | Best format: a specific tester ask, edge cases, privacy/local data, honest maturity, and detailed comment replies. Do not repeat the venue because its visible rules prohibit advertising. |
| [Plembfin: an AGPL-3.0 watch-state sync hub](https://www.reddit.com/r/opensource/comments/1vzsjnm/plembfin_an_agpl30_watchstate_sync_hub_for_plex/) | r/opensource | **5 upvotes, 7 comments, ~5.3K views** | Technical explainability resonated. Make the next post a genuine v1.0/architecture update, not a near-duplicate launch pitch. |
| [Looking for Trakt users to test a self-hosted multi-server sync tool](https://www.reddit.com/r/trakt/comments/1vzqu7a/looking_for_trakt_users_to_test_a_selfhosted/) | r/trakt | 0 upvotes, 7 comments, ~3.1K views | Reach was not zero, but engagement was weak. No current subreddit rules were surfaced, so obtain moderator confirmation before another promotional post. |
| [I built a self-hosted watch-state hub for people using more than one media server](https://www.reddit.com/r/SideProject/comments/1vzrh6o/i_built_a_selfhosted_watchstate_hub_for_people/) | r/SideProject | 2 upvotes, 4 comments, ~368 views | Good fit for a founder/build story; tighten the hook and ask two concrete feedback questions. |
| [Looking for testers…](https://www.reddit.com/r/vibecoding/comments/1vz6729/looking_for_testers_for_my_selfhosted_media_sync/) | r/vibecoding | 3 upvotes, 6 comments, ~4.9K views | Some reach, but less qualified for a self-hosting product. Avoid using it as a primary channel. |
| [Project showcase: a self-hosted watch-state hub…](https://www.reddit.com/r/homelab/comments/1vzsofl/project_showcase_a_selfhosted_watchstate_hub_for/) | r/homelab | Removed by moderators | The current submission form requires an exact software flair, mandatory answers, AI disclosure, and minimum karma. The earlier post did not visibly carry the required current flair; the missing requirements are the likely structural cause, but only moderators can confirm the reason. |
| [Welcome to r/plembfin](https://www.reddit.com/r/plembfin/comments/1w0jm3u/welcome_to_rplembfin/) | r/plembfin | 1 upvote, 0 comments, 38 views | Useful as an owned community home, not an acquisition channel yet. |
| [Restore Missing Episode Names](https://www.reddit.com/r/plembfin/comments/1w6da5k/restore_missing_episode_names/) | r/plembfin | 1 upvote, 0 comments, 9 views | Feature updates need an audience and a question; use the main communities for discovery. |

### Strongest message angle

Use this problem statement as the primary hook:

> When a household runs Plex, Emby, Jellyfin, and Trakt together, a watched-state change is not trustworthy unless the owner can see which source won, which destinations accepted it, why one was skipped, and how to retry only the failed destination.

Then ask for feedback on that workflow. The product should be the proposed solution, not the headline in every community.

## Real screenshot/image map

Use the existing product captures below. They show the real UI and avoid inventing product behavior. For Reddit, attach one focused image unless the community explicitly supports a gallery. For Product Hunt, use a small gallery. Do not use `stats.png` as evidence of customer traction; its figures look like demo data and should be labeled as demo data if shown.

Light-mode alternates are available in `website/public/assets/app-captures/`: `sync-activity-light.png`, `now-playing-light.png`, and `stats-light.png`. The assignments below deliberately mix light and dark captures. Use the light Stats capture only with an explicit “demo data” label.

| Channel/draft | Attach | Image caption/alt text |
| --- | --- | --- |
| r/selfhosted megathread | [`website/public/assets/app-captures/sync-activity-light.png`](../website/public/assets/app-captures/sync-activity-light.png) | “Plembfin Sync Activity showing source, per-destination delivery state, and retry context.” |
| r/homelab | [`docs/screenshots/sync-activity.png`](screenshots/sync-activity.png) | “A self-hosted sync ledger for a mixed media-server lab.” |
| r/opensource | [`website/public/assets/app-captures/sync-activity-light.png`](../website/public/assets/app-captures/sync-activity-light.png) | “Per-item sync outcomes and targeted retries in Plembfin.” |
| r/SideProject | [`website/public/assets/app-captures/now-playing-light.png`](../website/public/assets/app-captures/now-playing-light.png) | “Plembfin Now Playing across Plex, Emby, and Jellyfin.” |
| r/IMadeThis | [`docs/screenshots/now-playing.png`](screenshots/now-playing.png) | “The dashboard I built to see playback and history across services.” |
| r/indiebiz | [`website/public/assets/app-captures/now-playing-light.png`](../website/public/assets/app-captures/now-playing-light.png) | “A private, self-hosted view of a mixed media library.” |
| r/WebApps | [`docs/screenshots/now-playing.png`](screenshots/now-playing.png) | “Plembfin's web dashboard for active playback and watch history.” |
| Product Hunt | `sync-activity.png`, `now-playing-light.png`, optionally `stats-light.png` labeled “demo data” | Gallery order: problem proof, light daily-use dashboard, optional light analytics. |
| Show HN | `docs/plembfin-hub.svg` plus `docs/screenshots/sync-activity.png` only if the project is easy to try | Keep the screenshot secondary to a runnable experience. |

## Reddit rule and channel matrix

These are the rules visible in Chrome on 2026-09-10. “Safe” means the proposed format fits the visible rules; it is not a guarantee of moderator approval. Recheck the live sidebar and submission form immediately before posting because rules, flairs, megathreads, and moderator decisions can change.

### Recommended or conditionally usable

| Community | Decision | Exact gate for Plembfin |
| --- | --- | --- |
| [r/selfhosted](https://www.reddit.com/r/selfhosted/) | **Yes: current megathread only** | Plembfin is younger than three months by its current public history, so it belongs in the current [New Project Megathread](https://www.reddit.com/r/selfhosted/comments/1w6lmbj/new_project_megathread_week_of_03_sep_2026/), not a standalone post. Use the requested `Project Name / Repo/Website Link / Description / Deployment / AI Involvement` comment template. No standalone new-project post. |
| [r/homelab](https://www.reddit.com/r/homelab/) | **Conditional** | Must be relevant to homelab use; use the current **Project Showcase: Software - Mostly AI Generated** flair; disclose AI in the flair and text; answer every prompt; meet the subreddit karma requirement. Its visible commercial-advertising rule says non-commercial personal projects are permitted, while exceptions should go through modmail. If Plembfin is being presented as a commercial service or offer, ask moderators first. |
| [r/opensource](https://www.reddit.com/r/opensource/) | **Conditional** | Use the `Promotional` flair and make the post a distinct technical release/architecture update. Its visible self-promotion rule says Reddit recommends under 10% promotional posts and warns against using the community as a link farm. Do not mass-crosspost, ask for votes, use a sensational title, or post another near-duplicate immediately. |
| [r/SideProject](https://www.reddit.com/r/SideProject/) | **Yes, with care** | Use the community's requested title shape: `[Project name] - [Short description]`. Keep the post about the build and constructive feedback, not a bare link. The subreddit is intended for sharing projects and receiving feedback. |
| [r/IMadeThis](https://www.reddit.com/r/IMadeThis/) | **Yes, with care** | Its visible description welcomes people showing open-source projects and other things they made. Use one real image and a concise build story; do not turn it into a repeated ad. It is a small audience. |
| [r/indiebiz](https://www.reddit.com/r/indiebiz/) | **Yes, with care** | Use a self-post with the required title tag, preferably `[INTRO]`. Its visible guidance welcomes independent businesses/products but says moderators may curb spamminess. This is a small, founder-oriented audience. |
| [r/WebApps](https://www.reddit.com/r/WebApps/) | **Likely yes** | The only visible subreddit rule was **Web Apps Only**. Use a short web-app description, one screenshot, and a feedback question. Recheck for additional rules at submission time; reach is small. |

### Do not use as a promotional venue right now

| Community | Reason |
| --- | --- |
| [r/jellyfin](https://www.reddit.com/r/jellyfin/) | Visible rules include **No advertising**. The prior post performed best, but repeating it would directly conflict with the current rule. Only a genuinely helpful non-promotional answer, or an explicitly approved moderator exception, is appropriate. |
| [r/PleX](https://www.reddit.com/r/PleX/) | Visible rules include **No self-promotion** and no promotional/referral/selling posts. |
| [r/emby](https://www.reddit.com/r/emby/) | Visible rules include **No Paid Apps or Commercial Self-Promotion**. Ask moderators before any product post. |
| [r/HomeServer](https://www.reddit.com/r/HomeServer/) | Visible rules include no advertising/company advertising and no obvious AI-generated content. |
| [r/docker](https://www.reddit.com/r/docker/) | Visible rules say projects must be older than three months, in addition to promotion/spam restrictions. Plembfin is not old enough for a new project post yet. |
| [r/freesoftware](https://www.reddit.com/r/freesoftware/) | Visible rules prohibit software created by Generative AI/vibe-coding. Plembfin was heavily AI-assisted, so do not submit it there. |
| [r/trakt](https://www.reddit.com/r/trakt/) | No concrete subreddit rules surfaced in the current or old rules view, and the previous post received 0 upvotes. Treat it as moderator-confirmation required, not safe-by-default. |

## Reddit drafts

The following drafts are written for the channel, use a real screenshot, and ask for useful feedback. They are not instructions to publish automatically.

### 1. r/selfhosted: current New Project Megathread only

**Target:** top-level comment in the current weekly megathread, not a standalone post.

**Attach:** [`website/public/assets/app-captures/sync-activity-light.png`](../website/public/assets/app-captures/sync-activity-light.png)

```text
Project Name: Plembfin

Repo/Website Link: https://plembfin.com

Description:
Plembfin is a self-hosted watch-state hub for people who use more than one media server. It keeps a local SQLite record and reconciles watched status, playback progress, and repeat plays across Plex, Emby, Jellyfin, and Trakt.

The part I most want reviewed is the explainable sync activity: each item and destination records success, error, or skipped status, a plain-text reason, retry state, and targeted retry options. It also includes Now Playing, stats, upcoming episodes, metadata, Seerr integration, and backups. Plembfin is AGPL-3.0.

Deployment:
Plembfin can be run with Docker Compose or the GHCR image:
https://ghcr.io/lasikiewicz/plembfin:latest

The repository includes the Compose setup and documentation. Data is kept on local storage. The current release is v1.0.0, but it is still early in real-world usage, so testers should take a backup before connecting live libraries.

Source repository: https://github.com/Lasikiewicz/plembfin

AI Involvement:
The implementation was heavily AI-assisted through agentic workflows. I defined the requirements and architecture, reviewed changes, tested integrations and browser flows, and continue to maintain and review the result. AI is not required at runtime.

I am especially interested in feedback from people running mixed Plex/Emby/Jellyfin libraries: does the conflict explanation make a sync failure understandable, and what recovery case is still missing?
```

**Preflight:** confirm the link, deployment docs, image, and current megathread are live. Do not add a second top-level comment or create a standalone new-project post.

### 2. r/homelab: Project Showcase: Software - Mostly AI Generated

**Target title:** `Plembfin: explainable watch-state sync for mixed media-server labs`

**Attach:** [`docs/screenshots/sync-activity.png`](screenshots/sync-activity.png)

**Mandatory form preflight:** choose the current **Project Showcase: Software - Mostly AI Generated** flair and answer all four prompts shown by the form. The exact prompt currently asks for:

1. A GitHub/similar repository with at least one month of commit history and screenshots.
2. The problem the project solves and why it was created instead of using an existing FOSS solution.
3. How it is relevant to r/homelab or benefits its members.
4. What role AI/LLMs played and how much the project relied on them.

**Draft body:**

```text
Plembfin is a self-hosted watch-state hub for a media lab that has grown beyond one server. It keeps a local SQLite record of watched state, resume progress, and repeat plays, then reconciles that state across Plex, Emby, Jellyfin, and Trakt.

The lab problem is not only “did the sync run?” It is “which source won, which destination accepted the change, why was another destination skipped, and can I retry only that destination?” Plembfin's Sync Activity view records those per-item/per-destination outcomes and exposes targeted retries. It also provides Now Playing, history, stats, metadata, Seerr integration, and backups.

I created it because the existing tools I found tended to solve one provider pair, scrobbling, or public tracking. I wanted a private, local canonical record for a mixed-server household, with the operational evidence needed to recover from outages, rebuilt libraries, duplicates, and mismatched episode identities.

It is relevant to r/homelab because it runs beside the media stack on the user's own hardware and is designed around multiple self-hosted services, local storage, Docker Compose, webhooks, polling backstops, and backup/recovery workflows. Website: https://plembfin.com
Repository: https://github.com/Lasikiewicz/plembfin

This is a non-commercial personal project. The current release is v1.0.0 and the license is AGPL-3.0. Please back up before testing against a live library.

AI disclosure: the implementation was heavily AI-assisted. I directed the requirements and architecture, reviewed the generated changes, tested integrations and browser flows, and remain responsible for maintenance and review. AI is not required at runtime.

I would value feedback from other lab operators on whether the sync evidence is sufficient to diagnose a conflict without reading server logs, and which recovery workflow should be improved next.
```

**Do not submit** if the account fails the current karma threshold, if the project is being offered commercially, or if the form asks for a response not covered above. In the commercial case, contact the moderators through modmail first.

### 3. r/opensource: v1.0 technical update

**Title:** `Plembfin v1.0: explainable per-destination watch-state sync for Plex, Emby, Jellyfin and Trakt`

**Flair:** `Promotional` (verify the current flair name before submitting).

**Attach:** [`website/public/assets/app-captures/sync-activity-light.png`](../website/public/assets/app-captures/sync-activity-light.png)

```text
Plembfin is now at v1.0.0: an AGPL-3.0, self-hosted watch-state hub for people who run more than one media server.

Website: https://plembfin.com

The design decision I would most like open-source/self-hosting people to critique is the local sync ledger. Plembfin keeps the canonical record in SQLite, then records delivery separately for each destination. A sync entry can show success, error, or skipped, with a plain-language reason such as a newer state winning or no matching item being found. Failed or skipped destinations can be retried without blindly replaying the whole sync.

The current release also includes cross-platform resume progress, repeat-play history, manual watch review, Now Playing, metadata/search, Seerr integration, and automated local backups. It runs as a Node/Express/SQLite application with Docker Compose support:

https://github.com/Lasikiewicz/plembfin

The goal is not to create another public watch profile. It is to keep a private, inspectable source of truth on the user's hardware when libraries are split across Plex, Emby, Jellyfin, and Trakt. It is licensed AGPL-3.0.

AI disclosure: development was heavily AI-assisted under my direction. I defined the requirements and architecture, reviewed changes, tested the integrations and browser flows, and maintain/review the project. AI is not needed to run Plembfin.

For people who have built sync systems: is per-destination delivery evidence the right abstraction, and what conflict or recovery case would you expect to see next?
```

**Guardrail:** this must be a distinct v1.0/architecture post, not a copy of the earlier tester post. Do not ask for upvotes, do not mass-crosspost, and do not make another promotional post until the account has contributed normally in the community.

### 4. r/SideProject: founder/build story

**Title:** `Plembfin - a local-first watch-state hub for mixed Plex, Emby and Jellyfin setups`

**Attach:** [`website/public/assets/app-captures/now-playing-light.png`](../website/public/assets/app-captures/now-playing-light.png)

```text
I started Plembfin after realizing that “watched” stopped being a reliable fact once a household used more than one media server. Plex, Emby, Jellyfin, and Trakt could each know a slightly different version of the same history, especially after a library rebuild, an outage, or a rewatch.

Plembfin is my attempt to make that state local, private, and explainable. It keeps a canonical record in SQLite, reconciles watched state/resume progress/rewatches across the connected services, and shows the delivery result for each destination. The useful part is not a dashboard that says “sync complete”; it is being able to see why one item was skipped and retry only that destination.

The project is now at v1.0.0, is AGPL-3.0, and can be run with Docker Compose:
Website: https://plembfin.com
https://github.com/Lasikiewicz/plembfin

I also added manual watch review, richer media details, backups, Now Playing, stats, and Seerr integration. It is still an early project, so back up before connecting a live library.

I would love constructive feedback on two things:
1. Does the Sync Activity view explain failures clearly enough for a non-developer?
2. If you run more than one media server, what state or recovery case would stop you from trusting a tool like this?

The implementation was heavily AI-assisted under my direction. I reviewed and tested the result, and AI is not required at runtime.
```

### 5. r/IMadeThis: concise build showcase

**Title:** `I made Plembfin, a self-hosted watch-state hub for mixed media servers`

**Attach:** [`docs/screenshots/now-playing.png`](screenshots/now-playing.png)

```text
I made Plembfin for the awkward case where a household has Plex, Emby, Jellyfin, and Trakt at the same time.

It keeps a private canonical watch history in local SQLite, syncs watched state/resume progress/rewatches across those services, and records the result per destination. The goal is to make a sync failure explainable and recoverable instead of silently losing history.

It is self-hosted, AGPL-3.0, and available with Docker Compose:
Website: https://plembfin.com
https://github.com/Lasikiewicz/plembfin

The current release is v1.0.0. It also has Now Playing, history, stats, metadata, Seerr integration, and backups. Please back up before testing against a real library.

The implementation was heavily AI-assisted, but I directed the design, reviewed the changes, tested the integrations, and maintain the project.

What part of the interface would you want to understand before trusting it with your watch history?
```

### 6. r/indiebiz: independent-project introduction

**Title:** `[INTRO] Plembfin: a self-hosted watch-state hub for mixed media libraries`

**Attach:** [`website/public/assets/app-captures/now-playing-light.png`](../website/public/assets/app-captures/now-playing-light.png)

```text
Plembfin is an independent, AGPL-3.0 project for people who use more than one media server. It keeps watched history, resume progress, and repeat plays in a local SQLite record, then reconciles that state across Plex, Emby, Jellyfin, and Trakt.

The product idea is simple: a private “brain in the middle” for a media stack. The differentiator is operational visibility: per-destination outcomes, human-readable reasons, targeted retries, and backup/recovery tools.

It is self-hosted and available through Docker Compose. Website: https://plembfin.com
Repository: https://github.com/Lasikiewicz/plembfin

I am introducing it to get feedback on positioning and onboarding rather than making a hard sales pitch. What would make a self-hosted media tool feel trustworthy enough to try?
```

### 7. r/WebApps: short product/feedback post

**Title:** `Plembfin: a web app that reconciles watch state across Plex, Emby, Jellyfin and Trakt`

**Attach:** [`docs/screenshots/now-playing.png`](screenshots/now-playing.png)

```text
Plembfin is a self-hosted web app for people whose watch history is split across Plex, Emby, Jellyfin, and Trakt.

It stores a local canonical record, syncs watched state/resume progress/rewatches, and makes each destination's result visible in Sync Activity. It also includes Now Playing, history, stats, metadata, Seerr integration, and backups.

Website: https://plembfin.com
Repo: https://github.com/Lasikiewicz/plembfin

The current release is v1.0.0 and the license is AGPL-3.0. The implementation was heavily AI-assisted under my direction; AI is not required at runtime.

Does the screenshot make the main value understandable, or does the app need to lead with a simpler first-run story?
```

## Comment response bank

Use these only as accurate, conversational answers to questions that are actually asked. Do not paste them as unsolicited replies.

**“How do conflicts work?”**

Plembfin records each sync attempt per item and destination. The result can be success, error, or skipped, with a plain-text reason such as a newer state taking precedence or no matching item being found. Retry count/next-retry context is kept, and a targeted retry can resend only the failed or skipped destination.

**“How is this different from a sync/scrobble plugin?”**

Plembfin is intended as a full local hub rather than a single-provider bridge: local SQLite is the canonical record, watched state flows both ways among the connected providers, and the app adds operational history, recovery, metadata, dashboard, stats, and backup workflows.

**“Is it safe with a real library?”**

It is early software. Back up first, test with a small library, and review Sync Activity before trusting it with a larger live setup. Do not share media-server credentials or private URLs in a public issue or comment.

**“Will you add Simkl/Letterboxd/Kodi/etc.?”**

Answer with the actual roadmap state. Do not promise a date. Explain that additional providers are considered after the canonical model and current integrations remain stable.

## Non-Reddit channels and drafts

### Product Hunt: prepare a draft, then schedule intentionally

Product Hunt's current help center says makers may post their own product, the launch needs a personal account, and the submission includes a direct URL, a short description, makers, a first comment, and a schedule-or-draft choice. Self-hunting is allowed. The current relaunch guidance asks for a six-month gap for the same root domain unless a significant update is approved, so first check whether Plembfin already has a Product Hunt product page or launch.

Official references: [how to post a product](https://help.producthunt.com/en/articles/479557-how-to-post-a-product), [Hunter vs Makers](https://help.producthunt.com/en/articles/10082986-hunter-vs-makers-and-how-to-change-them), [relaunch policy](https://help.producthunt.com/en/articles/484934-can-i-relaunch-my-product), and [featuring guidelines](https://help.producthunt.com/en/articles/9883485-product-hunt-featuring-guidelines).

**Suggested product name:** `Plembfin`

**Suggested tagline/description (keep within the submission field's current limit):**

> The local-first watch-state hub for Plex, Emby, Jellyfin and Trakt. Keep watched history, resume progress and rewatches canonical in SQLite, then sync every destination with explainable activity, targeted retries, backups and a private dashboard.

**Suggested maker first comment:**

```text
Hi Product Hunt, I built Plembfin for the point where one media server becomes three and “watched” is no longer a trustworthy fact.

Website: https://plembfin.com

Plembfin keeps a private canonical record on your own hardware, then reconciles watched state, resume progress, and repeat plays across Plex, Emby, Jellyfin, and Trakt. The feature I care most about is the Sync Activity ledger: it shows the source, destination, outcome, reason, and retry context for each delivery instead of hiding everything behind one sync status.

The current release is v1.0.0, AGPL-3.0, self-hosted, and available through Docker Compose. It also includes Now Playing, history, stats, metadata, Seerr integration, and backups.

I would love feedback from people with a mixed media stack: what would you need to see before trusting a local tool with your watch history?

The implementation was heavily AI-assisted under my direction. I reviewed the generated changes, tested the integrations and browser flows, and maintain/review the project. AI is not required at runtime.
```

**Gallery:** keep the dark `sync-activity.png`, add the light `now-playing-light.png`, and optionally add the light `stats-light.png` only with a visible “demo data” caption if the figures are not real user analytics.

**Launch-day plan:** be present in the comments, answer technical questions, and share the Product Hunt link organically with people already interested in Plembfin. Do not mass-DM users, offer incentives for votes, or coordinate an upvote push; Product Hunt's current sharing guidance explicitly discourages those tactics. See [How do I share my post?](https://help.producthunt.com/en/articles/2690626-how-do-i-share-my-post).

### Product Hunt Product Forum: ongoing, not a second launch blast

After the product page exists, use its forum for build-in-public updates and questions. Product Hunt says each product forum exists for product-focused conversations and that threads notify followers. Add the forum as an official community link on plembfin.com.

First three threads:

1. `What should a trustworthy sync ledger explain?`: show one anonymized Sync Activity row and ask which reason/retry details are missing.
2. `What I learned from rebuilding watch-state around a local canonical record`: explain the model and trade-offs.
3. `v1.0 recovery checklist`: explain backups, rebuilt libraries, duplicate plays, and how to test safely.

Reference: [Maker's guide to Product Forums](https://help.producthunt.com/en/articles/11432379-maker-s-guide-to-product-forums).

### Indie Hackers: publish the lesson, not a launch announcement

The best fit is a build/lessons post with one product link at the end. Avoid a “please try my app” link dump. Indie Hackers' community-marketing guidance emphasizes that self-promotion must provide value and that every community has its own rules.

**Suggested title:** `What I learned making watch history reliable across four media services`

**Outline:**

1. The trigger: watched state drifting after library rebuilds and mixed providers.
2. Why a local canonical record was chosen instead of another scrobbling layer.
3. The difficult cases: rewatches, resume progress, missing matches, provider outages, and newer-state conflicts.
4. Why per-destination delivery evidence matters.
5. What changed before v1.0: manual review, retries, backup/recovery, and onboarding.
6. What is still uncertain: adoption, provider edge cases, and which integrations matter next.
7. Link to <https://plembfin.com> and ask for critique of the model, not votes.

**Opening draft:**

```text
I thought the hard part of watch-state sync would be calling four APIs. It turned out to be deciding what “truth” means when each service has a partial, delayed, or contradictory view of the same history.

I built Plembfin around a local canonical record instead of letting one provider silently overwrite another. That made the product less like a scrobbler and more like an operational ledger: every destination gets an outcome, a reason, and a retry path. The design is now running in v1.0.0, but the interesting questions are still about trust and recovery rather than feature count.

Website: https://plembfin.com
```

Reference: [Indie Hackers community-based marketing guide](https://www.indiehackers.com/post/guide-how-to-do-community-based-marketing-ee5c766673).

### DEV: technical article, not an advertisement

DEV's current moderation guidance says **information over promotion**; its Code of Conduct also asks authors to disclose AI assistance when used to create content. Use DEV only for a genuinely useful technical article, with Plembfin as the case study and a short link at the end.

**Suggested title:** `Designing an explainable sync ledger for watch state across media servers`

Website link to include near the article conclusion: https://plembfin.com

**Article structure:**

- Why boolean watched/unwatched state is insufficient.
- Canonical identity and event lifecycle.
- Per-destination delivery results.
- Conflict explanations and targeted retries.
- Idempotency, duplicate plays, and rebuilt libraries.
- Backup/recovery boundaries.
- Testing provider integrations and browser flows.
- AI assistance disclosure and what was reviewed manually.

Reference: [DEV community moderation and support](https://dev.to/devteam/community-moderation-and-support-on-dev-7me) and [DEV Code of Conduct](https://dev.to/code-of-conduct).

### Hacker News: a gated Show HN opportunity

Hacker News is potentially high-value for the architecture, but it is not a safe first launch channel. Its current Show HN guidance expects something people can try, asks for a non-trivial project and an explanation of how/why it was made, and says not to ask friends to upvote or comment. The general guidelines also say not to use HN primarily for promotion and prohibit generated/AI-edited text.

References: [Show HN guidelines](https://news.ycombinator.com/showhn.html) and [Hacker News guidelines](https://news.ycombinator.com/newsguidelines.html).

**Gate before posting:**

- A fresh user can run the app from the repository with the documented path.
- The first-run experience does not require access to the owner's private media servers.
- The post links to something people can actually run or inspect, not only a landing page.
- The title starts with `Show HN:`.
- The final prose is manually written and edited by the author; the draft below is only a set of talking points, not text to paste into HN.

**Candidate title:** `Show HN: Plembfin: local-first watch-state sync for mixed media servers`

**Manual talking points:** explain the real problem, show the canonical/local model, show one Sync Activity outcome and retry, explain how to try it, point to `https://plembfin.com` for the product overview, state the AGPL license and AI assistance honestly, and invite technical criticism. Do not ask for votes, do not use a hype-heavy title, and do not post merely because v1.0 has a new UI.

### GitHub Releases and Discussions: owned conversion path

Create a v1.0.0 release discussion with:

- Three-line value proposition.
- “What changed since the tester round”: canonical identity repairs, Jellyfin 12 support, manual watch review, backups, explainable Sync Activity, and onboarding improvements.
- One Sync Activity screenshot and one Now Playing screenshot.
- Fresh-install and backup-first links.
- A short “known limitations” section.
- A request for reproducible bug reports with provider, version, item type, and relevant Sync Activity reason, not credentials or private URLs.

Suggested discussion title: `v1.0.0: explainable sync activity and safer recovery workflows`

Website: https://plembfin.com

### Plembfin Discord: nurture the people who already care

Use the existing Discord as the tester/support destination rather than scattering support across every promotional post. Create or confirm channels for `announcements`, `setup-help`, and `sync-debugging`. The launch message should link to the release and ask testers to start with a backup and a small library.

Suggested announcement:

```text
Plembfin v1.0.0 is out.

The focus of this release is trust: local canonical watch history, per-destination Sync Activity, human-readable reasons, targeted retries, safer watch review, and backup/recovery workflows for mixed Plex, Emby, Jellyfin, and Trakt setups.

If you are testing, please start with a backup and a small library. When reporting a problem, include the provider, media type, and the Sync Activity result/reason. Please do not post credentials or private server URLs.

Website: https://plembfin.com
Release: https://github.com/Lasikiewicz/plembfin/releases
```

### Official Plex/Emby/Jellyfin communities and forums: permission first

Their audiences are highly relevant, but Reddit's current rules make direct promotion unsuitable in r/PleX, r/emby, and r/jellyfin. If using an official forum, Discord, Matrix, or discussion board, ask the moderators where a self-hosted integration/build announcement belongs before posting. Offer a technical guide or troubleshooting contribution rather than a blanket ad.

**Modmail/request draft:**

```text
Subject: Where should a self-hosted watch-state integration announcement go?

Hi moderators,

I maintain Plembfin, an AGPL-3.0 self-hosted tool that keeps a local canonical watch-state record and reconciles it across Plex, Emby, Jellyfin, and Trakt. I would like to share a technical write-up about the integration and its per-destination sync/recovery model, not a paid offer or referral link.

Is there a designated forum/category/thread for this kind of project, or would you prefer that I only answer relevant support questions? I will follow the community's preferred format and will not post until I have your guidance.

Website: https://plembfin.com
Repository: https://github.com/Lasikiewicz/plembfin
```

### Discovery lists: submit when mature enough

After the project has a stable release, complete docs, and a few independent users, consider an issue/PR submission to relevant open-source self-hosting lists such as Awesome Selfhosted or Docker application directories. Treat this as a documentation/discovery task, not a promotional campaign. Check each list's contribution rules and taxonomy at the time of submission.

## Rollout plan

### Phase 0: prepare and measure

- Confirm the current v1.0.0 docs and Docker path work from a fresh checkout.
- Add a short tester/reporting guide and a clear backup-first warning.
- Decide whether screenshots contain demo data; label it where necessary.
- Use one canonical website URL per channel and add channel-specific analytics only if the site's privacy/analytics policy supports it.
- Prepare a small release/media kit: logo, sync-activity screenshot, now-playing screenshot, 60-word description, 260-character Product Hunt description, and AI disclosure.
- Make a rule worksheet with the date checked, exact flair, required fields, URL, and the person who rechecked it.

### Phase 1: qualified Reddit feedback

Post at most one Reddit draft at a time, beginning with the current r/selfhosted megathread. Wait for the discussion to settle, answer every substantive comment, and record which questions recur. Then use r/SideProject or r/IMadeThis, followed later by the distinct r/opensource v1.0 update. Use r/homelab only after the form preflight succeeds and the non-commercial/personal-project status is accurate.

Do not publish to r/jellyfin, r/PleX, r/emby, r/HomeServer, r/docker, or r/freesoftware as promotional posts under the currently visible rules.

### Phase 2: owned and founder channels

- GitHub v1.0 release/discussion.
- Discord announcement and tester support.
- Product Hunt draft, product page, gallery, and launch-day comment plan.
- Indie Hackers lessons/build story.
- Product Hunt product forum follow-up threads.

### Phase 3: technical reach

- DEV technical article after it is useful without clicking through.
- Hacker News only after the easy-to-try gate passes and the final copy is written manually.
- Moderator-approved official forum/community posts.
- Discovery-list submissions once maturity and documentation are strong enough.

## Measurement

Track each channel separately:

- Website visits and repository clicks.
- Docker image pulls where available.
- Discord joins attributable to the channel.
- New issue/bug-report quality, not just issue count.
- First successful setup and first completed sync for new testers.
- Seven-day return/continued use where it can be measured privately and ethically.
- Comment quality: recurring objections, setup blockers, and requested integrations.

Reddit upvotes and view counts are useful leading signals, but the best previous post's 21K views did not automatically make it the safest or highest-converting venue. The main success metric should be qualified testers who complete a safe first sync and can explain what happened.

## Final pre-submit checklist

- [ ] The live community rules and submission form were rechecked today.
- [ ] The destination is allowed for this exact type of self-promotion.
- [ ] The post uses the correct flair and every mandatory prompt is answered.
- [ ] The title is specific and non-sensational.
- [ ] The body gives useful context before the link.
- [ ] The screenshot is a real Plembfin capture and demo data is labeled.
- [ ] AI assistance is disclosed where required or materially relevant.
- [ ] The post is not an identical cross-post of a recent submission.
- [ ] No vote request, incentive, mass-DM, or coordinated voting is planned.
- [ ] The tester path, docs, and backup warning work.
- [ ] The author is ready to answer comments and disclose limitations.
- [ ] User has explicitly approved this exact destination and draft immediately before submission.

## Monitoring links and reply workflow

Use the links below to check for new replies, comments, questions, and moderation notices. Direct post or comment links are recorded for the refreshed Reddit submissions. If a future submission is not recorded, find the latest Plembfin post on the subreddit page before reviewing its replies. Do not guess a Reddit post ID.

| Channel | Status | Check link | What to review |
| --- | --- | --- | --- |
| Reddit r/selfhosted | Published comment, 1 external reply, answered | [live comment](https://www.reddit.com/r/selfhosted/comments/1w6lmbj/comment/p8x6yus/?context=1&screen_view_count=2&ext-referrer=DIRECT) | The external reply was answered by the OP; check for anything newer |
| Reddit r/IMadeThis | Published post, 1 external comment, answered | [live post](https://www.reddit.com/r/IMadeThis/comments/1wceexd/comment/p8x5o8k/?screen_view_count=2) | The external comment was answered by the OP; check for anything newer |
| Reddit r/homelab | Removed by moderators, 1 AutoModerator notice | [removed post](https://www.reddit.com/r/homelab/comments/1wcedf7/plembfin_explainable_watchstate_sync_for_mixed/) | Review the removal reason; do not reply publicly unless an appeal is chosen |
| Reddit r/opensource | Published post, 0 comments | [live post](https://www.reddit.com/r/opensource/comments/1wcedrm/plembfin_v10_explainable_perdestination/) | Check again for new technical feedback |
| Reddit r/SideProject | Published post, 1 external comment, awaiting response | [live post](https://www.reddit.com/r/SideProject/comments/1wceem3/plembfin_a_localfirst_watchstate_hub_for_mixed/) and [direct comment](https://www.reddit.com/r/SideProject/comments/1wceem3/comment/p8xc1t7/?screen_view_count=2&ext-referrer=DIRECT) | Draft a response to the performance review and partial-sync trust question |
| Reddit r/indiebiz | Removed by Reddit filters, 0 comments | [removed post](https://www.reddit.com/r/indiebiz/comments/1wcefbh/intro_plembfin_a_selfhosted_watchstate_hub_for/) | Review the removal status; do not repost without checking the rules and filter cause |
| Reddit r/WebApps | Published post, 0 comments | [live post](https://www.reddit.com/r/WebApps/comments/1wceedg/plembfin_a_web_app_that_reconciles_watch_state/) | Check again for product feedback |
| Reddit r/plembfin | Existing owned community, checked latest and welcome posts, 0 comments | [latest release](https://www.reddit.com/r/plembfin/comments/1wbv9dq/plembfin_v100_released/) and [welcome post](https://www.reddit.com/r/plembfin/comments/1w0jm3u/welcome_to_rplembfin/) | Check comments on these and newer community posts |
| DEV | Published, 1 external comment, no reply yet | [article](https://dev.to/plembfin/designing-an-explainable-sync-ledger-for-watch-state-across-media-servers-5g89) and [comment](https://dev.to/raknaos/comment/3egb6) | Draft a response to the identity reconciliation question |
| Product Hunt | Scheduled for September 11, 2026 at 12:01 AM PDT, 1 maker comment, no external replies | [launch page](https://www.producthunt.com/posts/plembfin), [product page](https://www.producthunt.com/products/plembfin?launch=plembfin), [forum](https://www.producthunt.com/p/plembfin), and [edit page](https://www.producthunt.com/posts/plembfin/edit) | After launch, check comments, maker questions, moderation, and launch status |
| GitHub release | Private draft, no public release replies, no issues visible | [draft release](https://github.com/Lasikiewicz/plembfin/releases/edit/untagged-c2c7328b46e03a3dcead) and [issues](https://github.com/Lasikiewicz/plembfin/issues) | Check issues for new user reports after publication |
| Discord | Announcement prepared but unsent | [Plembfin announcements channel](https://discord.com/channels/1542449662047551558/1542462229419532359) | No announcement replies exist until the message is sent |
| Indie Hackers | No post possible | [Indie Hackers](https://www.indiehackers.com/) | No replies to monitor |
| Hacker News | Not posted | [Hacker News](https://news.ycombinator.com/) | No replies to monitor |

### When the user says "check the replies"

1. Open every live link in the monitoring table, including all seven refreshed Reddit venues, r/plembfin, the DEV article, the Product Hunt pages, and GitHub issues.
2. For Reddit venue links without an exact post URL, find the latest Plembfin post and record its direct URL before reviewing replies. Never invent a post ID.
3. Read every visible top-level comment and reply, including moderation or removal messages. Ignore unrelated page content and duplicate previews.
4. Draft a concise response for every comment that needs one. Ground each response in the current project state, include https://plembfin.com when relevant, and do not promise unconfirmed features, dates, or support.
5. Return a review table with the channel, commenter, comment summary, proposed response, and any required follow-up. Do not publish replies without a separate user instruction and confirmation.
6. Do not use em dashes in proposed responses, titles, links, or follow-up copy. Use commas, colons, parentheses, or separate sentences instead.

## Staging log: 2026-09-10

- Copy and image refresh: the campaign plan contains no em dashes, every recommended draft points to https://plembfin.com, and the image map mixes real light-mode and dark-mode captures.
- Reddit final rebuild and reply check: all seven refreshed Reddit submissions were found on the signed-in profile. The r/selfhosted and r/IMadeThis conversations each have one external reply or comment, and the existing OP responses are already posted. r/SideProject now has one external comment awaiting an OP response at https://www.reddit.com/r/SideProject/comments/1wceem3/comment/p8xc1t7/?screen_view_count=2&ext-referrer=DIRECT. r/WebApps and r/opensource have no comments. The r/homelab post was removed automatically for the account karma requirement, and the r/indiebiz post was removed by Reddit filters.
- Product Hunt: the existing Plembfin draft was updated with the new tagline and description, with https://plembfin.com included. The gallery shows six images with light and dark captures, and all changes are saved. The launch is scheduled for September 11, 2026 at 12:01 AM PDT. It is not live yet.
- GitHub: a private draft release for `v1.0.0` was saved with release notes and two attached screenshots, one dark and one light. The tag is not created until publication.
- DEV: the technical article was published with `selfhosted`, `opensource`, and `architecture` tags, a light dashboard-home cover, dark Sync Activity and light Now Playing body images, the website link, and the AI-assisted disclosure. Live URL: https://dev.to/plembfin/designing-an-explainable-sync-ledger-for-watch-state-across-media-servers-5g89
- Discord: the account joined the Plembfin server; the `#announcements` composer contains the release announcement, the website and release links, and dark Sync Activity plus light Now Playing attachments. The message remains unsent.
- Indie Hackers: the signed-in account currently reports that it cannot create posts, so no draft could be staged there.
- Hacker News: held at the research-only gate because the current guidelines disallow generated/AI-edited text and the project does not yet meet the plan's easy-to-try threshold.
- No GitHub release, Discord message, or forum thread was submitted during this pass. Product Hunt is scheduled but not live yet.
