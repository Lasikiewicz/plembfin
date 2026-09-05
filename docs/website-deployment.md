# Website deployment plan

This is the setup plan for publishing the static Astro documentation site from
`website/` to GitHub and having Cloudflare Pages deploy it automatically. It is a plan
only: do not push or deploy until the user explicitly requests that operation.

## Current repository shape

- Git remote: `https://github.com/Lasikiewicz/plembfin.git`
- Website source: `website/`
- Astro output: `website/dist/`
- Build command: `npm run build` from `website/`
- Current canonical site URL in `website/astro.config.mjs`: `https://plembfin.com`
- The website is a static Astro build (`output: "static"`); it does not need a Pages
  Function, Cloudflare Worker, API key, or runtime server.

The build reads the repository's root `package.json` and `CHANGELOG.md`, and copies the
root logo, diagram, and provider icons. Cloudflare must therefore build the repository
with `website` as its root directory, not from an exported `website` folder that omits
the rest of the repository.

## 1. Prepare the repository

The root `.gitignore` currently contains `website/`, which keeps this review copy out of
Git. Before the first GitHub deployment:

1. Remove only that root `website/` ignore rule.
2. Add `.local-review/` to `website/.gitignore` so local QA images stay untracked.
3. Keep `website/node_modules/`, `website/.astro/`, `website/dist/`, and `*.local` ignored.
4. Confirm the source and published assets are visible to Git:

   ```bash
   git check-ignore -v website/src/content/docs/guides.mdx
   git status --short --untracked-files=all
   ```

5. Review the list manually. Do not stage `node_modules`, `.astro`, `dist`, local review
   images, `.env` files, provider credentials, tokens, or signed-in browser data.
6. Stage the website source, public assets, `website/package-lock.json`, the website
   privacy manifest, and the related documentation only after the review is clean.

The website is a monorepo project. Keep all root source files used by
`website/scripts/build-release-data.mjs` and `website/scripts/sync-assets.mjs` in the
repository; do not make a second copy of them inside `website/`.

## 2. Validate locally before the first push

From the repository root:

```bash
cd website
npm ci
npm run check:content
npm run check:links
npm run check:assets
npm run check:privacy
npm run check:duplicates
npm run captures:inventory
npm run build
```

Then run the app and website preview together and inspect the affected pages in both
themes. The required baseline and visual/privacy rules are in
[`docs/websiteupdate.md`](websiteupdate.md).

## 3. Push the deployable branch to GitHub

1. Ensure the deployable website commit is on the repository's `main` branch.
2. Use the normal repository release workflow if the app is being promoted through
   `develop` → `alpha` → `main`; do not create a separate website-only release branch
   unless that is explicitly chosen.
3. Push the reviewed commit to GitHub only after the user explicitly authorizes the push.
4. Confirm GitHub shows `website/package-lock.json`, `website/src/`, `website/public/`,
   `website/scripts/`, and the root source files the build reads.

## 4. Create the Cloudflare Pages project

In Cloudflare:

1. Open **Workers & Pages**.
2. Select **Create application → Pages → Connect to Git**.
3. Install and authorize the Cloudflare GitHub app for the `Lasikiewicz/plembfin`
   repository only where possible.
4. Select `Lasikiewicz/plembfin`, then choose **Begin setup**.
5. Use these build settings:

   | Setting | Value |
   | --- | --- |
   | Production branch | `main` |
   | Root directory | `website` |
   | Build command | `npm run build` |
   | Build output directory | `dist` |
   | Node version | `22.19.0` via `NODE_VERSION` in Pages environment variables |

Set `NODE_VERSION` for both Production and Preview environments so Pages matches the
Node version used by the local setup guide. Do not add application secrets: this static
build only needs its package dependencies and repository files.

Leave automatic production deployments enabled. Leave preview deployments enabled for
pull requests and other non-production branches. Initially leave build watch paths at
their default so a root application, changelog, release, or asset change cannot silently
skip a docs rebuild. If watch paths are tightened later, include at least:
`website/**`, `public/**`, `server/src/**`, `docs/**`, `README.md`, `CHANGELOG.md`,
`changelog*.json`, `package.json`, and the website lockfile.

Save and deploy. A successful build should generate release data, synchronize shared
assets, run Astro's static build, and publish `dist/`.

## 5. Add the production domain

1. Open the Pages project and choose **Custom domains → Set up a domain**.
2. Add the final public domain. The current Astro canonical URL is `plembfin.com`; if a
   different hostname is selected, update `website/astro.config.mjs` before the first
   production deployment so canonical links and the sitemap agree with the domain.
3. For an apex domain, put the zone on Cloudflare and configure its nameservers. For a
   subdomain managed elsewhere, associate the domain in Pages first, then create the
   required CNAME to the Pages `*.pages.dev` hostname.
4. Wait for domain verification and HTTPS to become active. Do not rely on a manually
   created CNAME before associating the domain in Pages.

## 6. Verify the first deployment

Check the deployment log and then test the deployed site at its `pages.dev` hostname and
custom domain:

- `/` and `/docs/` return the expected pages;
- `/docs/guides/`, `/docs/getting-started/`, `/docs/movies/`, and
  `/docs/tv-shows/media-page/` load directly;
- all internal links remain path-only and do not expose local hostnames;
- dark and light screenshots load, including the full detail-page captures and focused
  Up Next and movie-menu captures;
- the movie three-dot screenshot matches the current six-action menu;
- preview and production pages contain no transient provider-error banner or identifying
  data in a published image; and
- the sitemap and canonical URLs use the intended public domain.

Every pull request should be checked on its Cloudflare preview URL before merge. Preview
deployments should not be treated as production rollback targets.

## 7. Operate and recover

- A push to `main` creates the production deployment automatically.
- A pull request gets a preview deployment that updates as the branch changes.
- Keep the Cloudflare GitHub app access scoped to the repository and review build logs
  for accidental secret output.
- If a production build is bad, use **Deployments → … → Rollback to this deployment**
  for the last successful production build, then fix the source and merge a normal
  follow-up commit.
- Run the website update workflow whenever app behavior, release data, routes, settings,
  or screenshots change. The Force-to-main website question in `CLAUDE.md` and
  `docs/websiteupdate.md` happens before promotion work begins.

## Official references

- [Cloudflare Pages Astro guide](https://developers.cloudflare.com/pages/framework-guides/deploy-an-astro-site/)
- [Cloudflare Pages Git integration](https://developers.cloudflare.com/pages/configuration/git-integration/)
- [Build configuration](https://developers.cloudflare.com/pages/configuration/build-configuration/)
- [Build image and Node versions](https://developers.cloudflare.com/pages/configuration/build-image/)
- [Monorepos](https://developers.cloudflare.com/pages/configuration/monorepos/)
- [Preview deployments](https://developers.cloudflare.com/pages/configuration/preview-deployments/)
- [Custom domains](https://developers.cloudflare.com/pages/configuration/custom-domains/)
- [Rollbacks](https://developers.cloudflare.com/pages/configuration/rollbacks/)
