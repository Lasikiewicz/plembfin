---
name: push-website-live
description: "Publish the current local Astro website directly to the separate Cloudflare Pages project. Use when the user says \"Push website live\" (case-insensitive). This never pushes GitHub or rebuilds the Plembfin application."
---

# Push website live

When the user explicitly says **"Push website live"**, publish the latest website
working tree directly to the existing `plembfin-website` Cloudflare Pages project.
The current checkout is the source of truth, including uncommitted website fixes.

## Boundaries

- Work from the repository root, with the site in `website/`.
- Do not checkout, pull, reset, stash, commit, or push Git branches.
- Do not run the root Plembfin build, Docker build, or any GitHub workflow.
- Do not deploy the `plembfin` application Pages project; the target is only
  `plembfin-website`.
- Do not deploy when a website check or build fails.

## Workflow

1. From `website/`, run the website deployment checks:

   ```bash
   npm run check:deploy
   ```

2. Build the current website tree:

   ```bash
   npm run build
   ```

3. Deploy the resulting `dist/` directly to Cloudflare Pages:

   ```bash
   npx --yes wrangler@latest pages deploy dist --project-name plembfin-website --branch main --commit-message "Update Plembfin website from local source" --commit-dirty=true
   ```

   If Wrangler needs network access or authentication, request the required permission
   or ask the user to complete Cloudflare login. Do not switch to a GitHub push as a
   workaround.

4. Verify the returned `pages.dev` deployment URL and `https://plembfin.com` both serve
   the new page successfully. Confirm the production response contains the current
   website output when a specific fix or marker is part of the request.

5. Report the production URL and any deployment URL. State clearly that this used the
   website-only path and did not trigger a Plembfin application rebuild on GitHub.

"Push to git", "Force to alpha", and "Force to main" remain separate workflows and do
not imply this website-only publish.
