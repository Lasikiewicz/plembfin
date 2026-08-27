#!/usr/bin/env node

// Submits a new release-announcement post to r/plembfin, un-stickies the
// previous post the bot account itself pinned (if any), and stickies the new
// one in slot 1. Reads changelog.json's newest entry. Silently no-ops when
// REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET/REDDIT_USERNAME/REDDIT_PASSWORD
// aren't all set, so forks and local runs never fail on it.

import fs from "node:fs";

const dryRun = process.argv.includes("--dry-run");

const subreddit = String(process.env.REDDIT_SUBREDDIT || "plembfin").trim();
const clientId = String(process.env.REDDIT_CLIENT_ID || "").trim();
const clientSecret = String(process.env.REDDIT_CLIENT_SECRET || "").trim();
const username = String(process.env.REDDIT_USERNAME || "").trim();
const password = String(process.env.REDDIT_PASSWORD || "").trim();

const userAgent = `github-actions:plembfin-release-bot:1.0 (by /u/${username || "plembfin-releases"})`;

function bulletList(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const lines = [];
  let used = 0;
  let shown = 0;
  for (const item of items) {
    const line = `- ${item}`;
    if (used + line.length + 1 > 3000) break;
    lines.push(line);
    used += line.length + 1;
    shown += 1;
  }
  if (shown < items.length) lines.push(`- …and ${items.length - shown} more`);
  return lines.join("\n");
}

function buildPost() {
  const changelog = JSON.parse(fs.readFileSync("changelog.json", "utf8"));
  const entry = changelog.entries?.[0];
  if (!entry) return null;

  const repo = process.env.GITHUB_REPOSITORY || "";
  const sha = process.env.GITHUB_SHA || "";
  const commitUrl = repo && sha ? `https://github.com/${repo}/commit/${sha}` : undefined;

  const sectionLabels = [
    ["newFeatures", "New Features"],
    ["majorBugFixes", "Major Bug Fixes"],
    ["tweaks", "Tweaks"],
  ];
  const sections = [];
  for (const [key, label] of sectionLabels) {
    const list = bulletList(entry.sections?.[key]);
    if (list) sections.push(`**${label}**\n\n${list}`);
  }
  if (sections.length === 0) {
    const list = bulletList(entry.details);
    if (list) sections.push(list);
  }

  const bodyParts = [String(entry.message || "")];
  if (sections.length) bodyParts.push(sections.join("\n\n"));
  if (commitUrl) bodyParts.push(`[View this commit](${commitUrl})`);

  return {
    title: `Plembfin v${entry.version} released`.slice(0, 300),
    text: bodyParts.join("\n\n"),
  };
}

const post = buildPost();
if (!post) {
  console.log("No changelog entry found, skipping Reddit release post.");
  process.exit(0);
}

if (dryRun) {
  console.log(JSON.stringify({ subreddit, ...post }, null, 2));
  process.exit(0);
}

if (!clientId || !clientSecret || !username || !password) {
  console.log("Reddit credentials are not fully configured, skipping Reddit release post.");
  process.exit(0);
}

async function getAccessToken() {
  const response = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": userAgent,
    },
    body: new URLSearchParams({ grant_type: "password", username, password }),
  });
  if (!response.ok) {
    throw new Error(`Reddit auth failed: ${response.status} ${await response.text()}`);
  }
  const data = await response.json();
  return data.access_token;
}

async function redditApi(token, path, params) {
  const response = await fetch(`https://oauth.reddit.com${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": userAgent,
    },
    body: new URLSearchParams({ api_type: "json", ...params }),
  });
  if (!response.ok) {
    throw new Error(`Reddit API request to ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function unstickPreviousPosts(token) {
  const response = await fetch(`https://oauth.reddit.com/r/${subreddit}/hot?limit=5`, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": userAgent },
  });
  if (!response.ok) {
    console.error(`Could not list current posts to un-sticky: ${response.status} ${await response.text()}`);
    return;
  }
  const listing = await response.json();
  const stickied = (listing.data?.children || [])
    .map((child) => child.data)
    .filter((data) => data?.stickied && data.author === username);

  for (const post of stickied) {
    await redditApi(token, "/api/set_subreddit_sticky", { id: post.name, state: "false" });
    console.log(`Un-stickied previous release post ${post.name}.`);
  }
}

const token = await getAccessToken();
await unstickPreviousPosts(token);

const submitted = await redditApi(token, "/api/submit", {
  sr: subreddit,
  kind: "self",
  title: post.title,
  text: post.text,
  sendreplies: "false",
});

const errors = submitted?.json?.errors;
if (errors && errors.length) {
  throw new Error(`Reddit rejected the post: ${JSON.stringify(errors)}`);
}

const fullname = submitted?.json?.data?.name;
if (!fullname) {
  throw new Error(`Reddit did not return a post id: ${JSON.stringify(submitted)}`);
}

await redditApi(token, "/api/set_subreddit_sticky", { id: fullname, state: "true", num: "1" });

console.log(`Posted and stickied release announcement to r/${subreddit}: ${submitted.json.data.url}`);
