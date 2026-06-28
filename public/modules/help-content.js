import { getWebhookToken } from "./auth.js";
import { escapeHtml, escapeAttribute } from "./utils.js";

function snippet(code, language = "text") {
  const trimmed = String(code).trim();
  return `
    <div class="copy-block">
      <button class="copy-button" type="button" data-copy="${escapeAttribute(trimmed)}" aria-label="Copy ${escapeHtml(language)} snippet">Copy</button>
      <pre><code>${escapeHtml(trimmed)}</code></pre>
    </div>
  `;
}

function terminalOutput(text) {
  return `<pre class="terminal-output"><code>${escapeHtml(text)}</code></pre>`;
}

export function adminTokenGuide() {
  return `
    <div class="guide-callout credential-guide">
      <b>Admin Sign-In</b>
      <p><b>What it is:</b> The local username and password for this self-hosted instance.</p>
      <ol>
        <li>Defaults to <code>admin</code> / <code>admin</code> on first run — you will be prompted to change the password immediately on first login.</li>
        <li>Override by setting <code>ADMIN_USERNAME</code> and <code>ADMIN_PASSWORD</code> environment variables (e.g. in <code>docker-compose.yml</code>).</li>
        <li>Use that username and password to sign in to this dashboard. Change credentials here at any time.</li>
        <li>Webhooks use a separate secret token. Media servers can use the token in the webhook URL; automation clients can send it with <code>X-Plembfin-Webhook-Secret</code> or <code>Authorization: Bearer</code>. You can rotate it independently without affecting your admin password or API key.</li>
      </ol>
    </div>
  `;
}

export function plexCredentialGuide() {
  return `
    <div class="guide-callout credential-guide">
      <b>PLEX_URL and PLEX_TOKEN Credential Extraction</b>
      <h3>Finding your PLEX_URL</h3>
      <ul>
        <li>If Plex is running on the same computer or local network, it usually defaults to <code>http://127.0.0.1:32400</code> or <code>http://localhost:32400</code>.</li>
        <li>If Plex is running on another machine, use that server's local IP address with port <code>32400</code>, such as <code>http://192.168.1.50:32400</code>.</li>
        <li>If you use a secure remote domain like <code>https://plex.example.com</code>, confirm it by opening Plex Web and checking the browser URL bar while connected to your server.</li>
        <li>You can also confirm the advertised LAN and remote addresses in Plex server network settings.</li>
      </ul>
      <h3>Finding your PLEX_TOKEN</h3>
      <ol>
        <li>Open a web browser, go to your Plex Web App, and sign in.</li>
        <li>Navigate to any library item, either a movie or a specific TV episode.</li>
        <li>Click the vertical ellipsis <code>...</code> button to open the context menu.</li>
        <li>Click <b>Get Info</b> from the menu.</li>
        <li>In the bottom-right corner of the pop-up modal, click the <b>View XML</b> text link.</li>
        <li>A new browser tab will open displaying raw XML code. Look at the address bar at the very top of your browser.</li>
        <li>Scroll to the absolute end of the URL string and locate <code>X-Plex-Token=</code>. Copy the exact alphanumeric string that follows it.</li>
        <li><b>Warning:</b> keep this private and do not commit it to public git history.</li>
      </ol>
    </div>
  `;
}

export function embyCredentialGuide() {
  return `
    <div class="guide-callout credential-guide">
      <b>EMBY_URL, EMBY_API_KEY, and EMBY_USER_ID Credential Extraction</b>
      <h3>Finding your EMBY_URL</h3>
      <ul>
        <li>If Emby is running locally, it is usually <code>http://localhost:8096</code>.</li>
        <li>If Emby is on another local server, use that server IP address with port <code>8096</code>.</li>
        <li>If you use a reverse proxy or public domain, use the secure URL you normally open in the browser, such as <code>https://emby.example.com</code>.</li>
      </ul>
      <h3>Generating your EMBY_API_KEY</h3>
      <ol>
        <li>Open your Emby Server web dashboard as an administrator.</li>
        <li>Click the gear icon in the top right to access <b>Server Settings</b>.</li>
        <li>In the left-hand sidebar, scroll down to the <b>Advanced</b> section and click <b>API Keys</b>.</li>
        <li>Click the <b>New API Key</b> button.</li>
        <li>Enter an app name identifier, for example <code>Plembfin Tracker</code>, and click OK.</li>
        <li>Copy the newly generated long character string from the table.</li>
      </ol>
      <h3>Finding your EMBY_USER_ID</h3>
      <ol>
        <li>In the Emby Server Settings left sidebar, click <b>Users</b>.</li>
        <li>Click on your active user account profile.</li>
        <li>Look at your browser's address bar URL.</li>
        <li>Extract the string value following <code>?userId=</code>. This is your unique identifier string.</li>
      </ol>
    </div>
  `;
}

export function jellyfinCredentialGuide() {
  return `
    <div class="guide-callout credential-guide">
      <b>JELLYFIN_URL, JELLYFIN_API_KEY, and JELLYFIN_USER_ID Credential Extraction</b>
      <h3>Finding your JELLYFIN_URL</h3>
      <ul>
        <li>If Jellyfin is running locally, it defaults to <code>http://localhost:8096</code> or <code>http://127.0.0.1:8096</code>.</li>
        <li>If Jellyfin is on another local server, use that server IP address with port <code>8096</code>.</li>
        <li>If you use a reverse proxy or public domain, use the secure URL you normally open in the browser, such as <code>https://jellyfin.example.com</code>.</li>
      </ul>
      <h3>Generating your JELLYFIN_API_KEY</h3>
      <ol>
        <li>Open your Jellyfin Dashboard using an administrator profile.</li>
        <li>Select the <b>Dashboard</b> menu option under the <b>Administration</b> section.</li>
        <li>Scroll down the left settings panel until you reach the <b>Advanced</b> header and select <b>API Keys</b>.</li>
        <li>Click the <code>+</code> icon button to generate a token. Name it <code>Plembfin Bridge</code>.</li>
        <li>Instantly copy the resulting string.</li>
      </ol>
      <h3>Finding your JELLYFIN_USER_ID</h3>
      <ol>
        <li>Go to your Jellyfin Dashboard settings page.</li>
        <li>Under the <b>Administration</b> header, click <b>Users</b>.</li>
        <li>Select your primary user profile card.</li>
        <li>Inspect the browser address bar. The long alphanumeric string right after <code>/users?userId=</code> is your true Jellyfin User ID.</li>
      </ol>
    </div>
  `;
}

export function buildWebhookUrl() {
  const token = getWebhookToken();
  const base = `${window.location.origin}/api/webhook`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

export function plexWebhookSetup() {
  const url = buildWebhookUrl();
  return `
    <div class="guide-callout" style="border-color: rgba(234, 179, 8, 0.3); background: rgba(234, 179, 8, 0.06);">
      <b>Plex Webhook Setup</b>
      <p style="margin: var(--space-1) 0; font-size: 0.8rem; color: var(--muted);">Webhook URL:</p>
      <code style="word-break: break-all; font-size: 0.75rem;">${escapeHtml(url)}</code>
      <p style="margin: var(--space-2) 0 0; font-size: 0.75rem; color: var(--muted);">Automation clients can also call <code>/api/webhook</code> with <code>X-Plembfin-Webhook-Secret</code> or <code>Authorization: Bearer</code>.</p>
      <ul style="padding-left: 1.2rem; margin: var(--space-2) 0 0; display: grid; gap: 4px;">
        <li>Set up webhooks per the <a href="https://support.plex.tv/articles/115002267687-webhooks/?utm_campaign=Plex%20Apps&utm_medium=Plex%20Web&utm_source=Plex%20Apps" target="_blank" rel="noopener noreferrer" style="color: var(--blue); text-decoration: underline;">Plex Webhook Documentation</a>. Point them to the URL above.</li>
        <li>Enable events: <code>media.play</code>, <code>media.resume</code>, <code>media.pause</code>, <code>media.stop</code>, <code>media.scrobble</code>.</li>
        <li><b>Unwatched sync (built-in):</b> Plembfin connects to your Plex Media Server via its WebSocket notification channel automatically — no external script required. Plex native webhooks cannot send unscrobble events, so this listener handles them.</li>
        <li><b>Fallback:</b> The background cron worker also polls Plex every minute to catch any missed unwatched removals.</li>
      </ul>
    </div>
  `;
}

export function embyWebhookSetup() {
  const url = buildWebhookUrl();
  return `
    <div class="guide-callout" style="border-color: rgba(16, 185, 129, 0.3); background: rgba(16, 185, 129, 0.06);">
      <b>Emby Webhook Setup</b>
      <p style="margin: var(--space-1) 0; font-size: 0.8rem; color: var(--muted);">Webhook URL:</p>
      <code style="word-break: break-all; font-size: 0.75rem;">${escapeHtml(url)}</code>
      <p style="margin: var(--space-2) 0 0; font-size: 0.75rem; color: var(--muted);">Automation clients can also call <code>/api/webhook</code> with <code>X-Plembfin-Webhook-Secret</code> or <code>Authorization: Bearer</code>.</p>
      <ul style="padding-left: 1.2rem; margin: var(--space-2) 0 0; display: grid; gap: 4px;">
        <li>Go to Emby Server Settings ➔ <b>Webhooks</b> and add a new webhook pointing to the URL above.</li>
        <li>Under <b>Events → Playback</b>, check: <code>Start</code>, <code>Pause</code>, <code>Unpause</code>, <code>Stop</code>.</li>
        <li>Under <b>Events → Users</b>, check: <code>Mark Played</code>, <code>Mark Unplayed</code>.</li>
        <li>Enable <b>Send All Properties</b> so payloads include <code>PlaybackPositionTicks</code> for resume sync.</li>
      </ul>
    </div>
  `;
}

export function jellyfinWebhookSetup() {
  const url = buildWebhookUrl();
  return `
    <div class="guide-callout" style="border-color: rgba(75, 150, 230, 0.3); background: rgba(75, 150, 230, 0.06);">
      <b>Jellyfin Webhook Setup</b>
      <p style="margin: var(--space-1) 0; font-size: 0.8rem; color: var(--muted);">Webhook URL:</p>
      <code style="word-break: break-all; font-size: 0.75rem;">${escapeHtml(url)}</code>
      <p style="margin: var(--space-2) 0 0; font-size: 0.75rem; color: var(--muted);">Automation clients can also call <code>/api/webhook</code> with <code>X-Plembfin-Webhook-Secret</code> or <code>Authorization: Bearer</code>.</p>
      <ul style="padding-left: 1.2rem; margin: var(--space-2) 0 0; display: grid; gap: 4px;">
        <li>Install the <b>Webhooks</b> plugin in the Jellyfin Dashboard (Plugins → Catalog).</li>
        <li>Add a new <b>Generic Webhook</b> named <code>plembfin</code> pointing to the URL above. Check <b>Enable</b>.</li>
        <li>Under <b>Notification Type</b>, check: <code>Playback Start</code>, <code>Playback Progress</code>, <code>Playback Stop</code>, <code>User Data Saved</code> <i>(required for mark-watched/unwatched events)</i>.</li>
        <li>Under <b>Item Type</b>, select: <code>Movies</code>, <code>Episodes</code>.</li>
        <li>Check <b>Send All Properties (ignores template)</b> so resume position fields are included.</li>
      </ul>
    </div>
  `;
}

export function webhookWarning() {
  return `
    <div class="guide-callout warning-callout" style="gap: var(--space-3); border-color: rgba(234, 179, 8, 0.45); background: rgba(234, 179, 8, 0.08);">
      <b style="font-size: 1.1rem; color: var(--yellow);">Webhook Setup & Unwatched Sync Guide</b>
      <p>Configure your media servers to send played and unplayed/unwatched events to your Plembfin webhook URL:</p>

      <div style="display: grid; gap: var(--space-2); margin-top: var(--space-2);">
        <h3 style="margin: 0; color: var(--text); font-size: 0.95rem; display: flex; align-items: center; gap: 6px;">
          <span style="display: inline-block; width: 8px; height: 8px; border-radius: 999px; background: #eab308;"></span>
          1. Plex Webhook Setup
        </h3>
        <ul style="padding-left: 1.2rem; margin: 0; display: grid; gap: 4px;">
          <li>Plex does not support sending unwatched (unscrobble) events via native webhooks or Tautulli.</li>
          <li>For resume sync, Plex webhook traffic must include playback lifecycle events such as <code>media.play</code>, <code>media.resume</code>, <code>media.pause</code>, <code>media.stop</code>, and <code>media.scrobble</code>. Plembfin reads <code>viewOffset</code> and <code>duration</code> when Plex provides them.</li>
          <li><b>Real-time Sync (Built-in):</b> Plembfin's server includes a built-in Plex notification listener. It connects to your Plex Media Server via the WebSocket notification channel (configured automatically from your Plex URL and token in Settings → Apps → Plex Setup) and forwards unwatched events directly — no external script or daemon is required.</li>
          <li><b>Cron Sync (Fallback):</b> Plembfin's background cron worker polls Plex periodically to check recently watched items and sync them to other servers if they are marked unwatched on Plex.</li>
          <li>For general playback events, set up webhooks according to the <a href="https://support.plex.tv/articles/115002267687-webhooks/?utm_campaign=Plex%20Apps&utm_medium=Plex%20Web&utm_source=Plex%20Apps" target="_blank" rel="noopener noreferrer" style="color: #4b96e6; text-decoration: underline;">Plex Webhook Documentation</a>.</li>
        </ul>
      </div>

      <div style="display: grid; gap: var(--space-2); margin-top: var(--space-2); border-top: 1px solid var(--line); padding-top: var(--space-2);">
        <h3 style="margin: 0; color: var(--text); font-size: 0.95rem; display: flex; align-items: center; gap: 6px;">
          <span style="display: inline-block; width: 8px; height: 8px; border-radius: 999px; background: #10b981;"></span>
          2. Emby Webhook Setup
        </h3>
        <ul style="padding-left: 1.2rem; margin: 0; display: grid; gap: 4px;">
          <li>In Emby Server Settings ➔ <b>Webhooks</b>, add a new webhook pointing to your Plembfin webhook URL.</li>
          <li>Under <b>Events</b>, check the following boxes:
            <ul style="padding-left: 1.2rem; margin-top: 2px;">
              <li><b>Playback</b>: Check <code>Start</code>, <code>Pause</code>, <code>Unpause</code>, and <code>Stop</code></li>
              <li><b>Users</b>: Check <code>Mark Played</code> and <code>Mark Unplayed</code></li>
            </ul>
          </li>
          <li>Resume sync uses Emby's <code>Pause</code> and <code>Stop</code> events. Those payloads need to include <code>PlaybackPositionTicks</code> or <code>PositionTicks</code>.</li>
        </ul>
      </div>

      <div style="display: grid; gap: var(--space-2); margin-top: var(--space-2); border-top: 1px solid var(--line); padding-top: var(--space-2);">
        <h3 style="margin: 0; color: var(--text); font-size: 0.95rem; display: flex; align-items: center; gap: 6px;">
          <span style="display: inline-block; width: 8px; height: 8px; border-radius: 999px; background: #4b96e6;"></span>
          3. Jellyfin Webhook Setup
        </h3>
        <ul style="padding-left: 1.2rem; margin: 0; display: grid; gap: 4px;">
          <li>Install the <b>Webhooks</b> plugin in the Jellyfin Dashboard (under Plugins).</li>
          <li>Add a new Generic Webhook named <code>plembfin</code> pointing to your Plembfin webhook URL.</li>
          <li>Check <b>Enable</b>.</li>
          <li>Under <b>Notification Type</b>, check the following boxes:
            <ul style="padding-left: 1.2rem; margin-top: 2px;">
              <li><code>Playback Start</code></li>
              <li><code>Playback Progress</code></li>
              <li><code>Playback Stop</code></li>
              <li><code>User Data Saved</code> <i>(Crucial: sends events when items are marked watched or unwatched)</i></li>
            </ul>
          </li>
          <li>Under <b>Item Type</b>, select:
            <ul style="padding-left: 1.2rem; margin-top: 2px;">
              <li><code>Movies</code></li>
              <li><code>Episodes</code></li>
            </ul>
          </li>
          <li>Check <b>Send All Properties (ignores template)</b>.</li>
          <li>Resume sync depends on Jellyfin sending <code>PlaybackPositionTicks</code>, <code>PositionTicks</code>, or item <code>UserData</code> playback position fields.</li>
        </ul>
      </div>
    </div>
  `;
}

export function cronSyncGuide() {
  const endpoint = `${window.location.origin}/api/cron-sync`;
  return `
    <section class="guide-callout" id="cron-sync-setup">
      <b>Background Sync Worker</b>
      <p>Plembfin runs a built-in scheduler directly inside the server process — no external cron job or cloud infrastructure is required. It fires once per minute as long as the server is running.</p>
      <h3>Manual trigger</h3>
      <p>To force an immediate run, send an authenticated POST to <code>/api/cron-sync</code>. You can also use <b>Force Sync</b> in the dashboard, which calls <code>/api/force-sync</code> and streams progress.</p>
      <h3>Authenticated request</h3>
      ${snippet(`POST ${endpoint}

X-Api-Key: <your-api-key>`, "http")}
      <h3>What this runs</h3>
      <p>The worker writes a heartbeat timestamp, polls Plex, Emby, and Jellyfin for active playback, updates live-session cache rows, detects completed sessions after 90% progress, writes completed watches to <code>watch_history</code>, dispatches outbound watched-state sync, checks recent Plex items for unwatched removals, and maintains <code>data/next-airing-cache.json</code> for TV show upcoming episode dates.</p>
    </section>
  `;
}

function rebuildPlaystateGuide() {
  return `
          <p><b>scripts/rebuildPlaystateDatabase.js</b> is the one-time database reset tool for rebuilding Plembfin from a Trakt export and the latest live Plex state. It preserves saved server/admin settings, clears media history and sync state, imports Trakt and Plex history, writes canonical playstate rows, then converges Plex, Emby, and Jellyfin.</p>
          <p>Run the dry run first. It reads the Trakt export folder and configured media server APIs, but does not write because <code>--write</code> is omitted. Only run the write command after the convergence plan looks safe.</p>
          <section class="guide-callout">
            <b>What the write pass changes</b>
            <ol>
              <li>Clears <code>watchHistory</code>, <code>playstate</code>, <code>playbackProgress</code>, sync logs, active-session cache, live-tracking cache, and derived history caches.</li>
              <li>Preserves saved Plex, Emby, Jellyfin, TMDB, and admin configuration.</li>
              <li>Imports Trakt <code>watched-history-*.json</code> and current watched movie/show exports.</li>
              <li>Pulls Plex full play history, current Plex watched state, and target-library availability from the live Plex API.</li>
              <li>Skips items unavailable in a target library instead of issuing thousands of failed mark-watched requests.</li>
            </ol>
          </section>
          <section class="guide-callout">
            <b>Dry run</b>
            <div class="copy-block">
              <button class="copy-button" type="button" data-copy="node scripts/rebuildPlaystateDatabase.js --trakt-dir &quot;C:\\Users\\lasik\\Downloads\\trakt-export-lasikie&quot;" aria-label="Copy dry-run command">Copy</button>
              <pre><code>node scripts/rebuildPlaystateDatabase.js --trakt-dir "C:\\Users\\lasik\\Downloads\\trakt-export-lasikie"</code></pre>
            </div>
          </section>
          <section class="guide-callout">
            <b>Write pass</b>
            <p>This clears and rebuilds Plembfin media data, then applies the convergence plan to all configured media servers.</p>
            <div class="copy-block">
              <button class="copy-button" type="button" data-copy="node scripts/rebuildPlaystateDatabase.js --trakt-dir &quot;C:\\Users\\lasik\\Downloads\\trakt-export-lasikie&quot; --write" aria-label="Copy write command">Copy</button>
              <pre><code>node scripts/rebuildPlaystateDatabase.js --trakt-dir "C:\\Users\\lasik\\Downloads\\trakt-export-lasikie" --write</code></pre>
            </div>
          </section>
        `;
}

function exportPlexHistoryGuide() {
  return `
          <p><b>scripts/exportPlexHistory.js</b> reads your full Plex play history and streams it into the local SQLite database via the import API. Use it once to seed historical watch data that webhooks and live session polling would otherwise miss (they only capture future activity).</p>
          <p>Use it once when you want to bootstrap a fresh deployment, or again if you are migrating an existing Plex library and need the cloud history to reflect years of prior viewing. The script does not need the browser open after launch; it reads the local configuration block, streams rows to the import API in batches, and finishes with a deterministic summary.</p>
          <section class="guide-callout">
            <b>Token discovery walkthrough</b>
            <ol>
              <li>Open a desktop browser such as Chrome, Firefox, Edge, or Safari.</li>
              <li>Navigate to the Plex Web App and sign in with an administrative account.</li>
              <li>Open any movie or series row from your library.</li>
              <li>Open the item action menu and select <b>Get Info</b>.</li>
              <li>Click <b>View XML</b> in the lower-right corner of the dialog to open the raw metadata page.</li>
              <li>Do not inspect the XML content itself. Look at the browser address bar and scroll to the end of the URL.</li>
              <li>Find the query parameter named <code>X-Plex-Token=</code> and copy the long alphanumeric string immediately after it.</li>
            </ol>
          </section>
          <section class="guide-callout">
            <b>Execution workflow</b>
            <p>Configure PLEX_URL and the harvested PLEX_TOKEN as environment variables before running. The import API authenticates with your configured API key.</p>
            <div class="copy-block">
              <button class="copy-button" type="button" data-copy="node scripts/exportPlexHistory.js" aria-label="Copy bash snippet">Copy</button>
              <pre><code>node scripts/exportPlexHistory.js</code></pre>
            </div>
            ${terminalOutput(`🚀 Initiating Local Plex History Extraction Engine...
      ✔ Connection established to local server at http://127.0.0.1:32400
      ℹ Found 3 media library sections to process.

      [1/3] Processing Section: "Movies" (ID: 1)
      → Found 450 watched titles. Streaming to local database in batches...
      └── Chunks: [██████████████████████████████] 100% | Sent 5/5 batches successfully.

      [2/3] Processing Section: "TV Shows" (ID: 2)
      → Traversing underlying episodes. Found 1,200 tracked played logs.
      └── Chunks: [██████████████████████████████] 100% | Sent 12/12 batches successfully.

      🎉 [SUCCESS] Historic data migration finalized!
      Total Rows Synced to Local Database: 1,650 items.
      Ecosystem is fully synchronized and ready for live playback tracking.`)}
          </section>
        `;
}

function forcePushHistoryGuide() {
  return `
          <p><b>scripts/forcePushHistory.js</b> is the ecosystem equalizer. It reads the local SQLite watch history, resolves each row against Plex, Emby, and Jellyfin, and replays the played state back out through their APIs so all three servers converge on the same watch record.</p>
          <p>It is meant for catch-up and repair, not for routine polling. Use it when you want to reconcile a clean server, recover from a migration, or make a newly joined platform match the canonical watch archive with no manual checkbox clicking.</p>
          <section class="guide-callout">
            <b>Platform setup walkthrough</b>
            <ol>
              <li>Open the Emby server settings page and sign in as an administrator.</li>
              <li>Navigate to <b>Advanced</b>, then <b>API Keys</b>, and generate an API key if needed.</li>
              <li>Open the target Emby user profile and copy the user ID from the browser URL parameter that follows <code>?userId=</code>.</li>
              <li>Repeat the same flow in Jellyfin: open the admin dashboard, create or confirm the API key, then copy the user identifier from the profile URL.</li>
              <li>Paste the harvested server URLs, API keys, and user IDs into the header block at the top of <code>scripts/forcePushHistory.js</code>.</li>
            </ol>
          </section>
          <section class="guide-callout">
            <b>Execution workflow</b>
            <p>Open scripts/forcePushHistory.js in your editor, configure your server credentials in the file header, then run the command below from the project root to synchronize your media ecosystem.</p>
            <div class="copy-block">
              <button class="copy-button" type="button" data-copy="node scripts/forcePushHistory.js" aria-label="Copy bash snippet">Copy</button>
              <pre><code>node scripts/forcePushHistory.js</code></pre>
            </div>
            ${terminalOutput(`🔄 Initiating Central Database Outward Force-Push Matrix...
      ✔ Fetched 1,650 master tracking history logs from website API.
      ℹ Mapping provider GUID parameters across target endpoints...

      [PROCESSING] Index: 001/1650 | 'Dimension 20 - S01E01' ➔ Synchronizing...
      ├── Plex Server Client API: [SKIPPED] (Already marked watched)
      ├── Emby Server Client API: [SUCCESS] Item resolved (ID: 8849) ➔ Sent PlayState HTTP 200 OK
      └── Jellyfin Server Client API: [SUCCESS] Cache-busted (ID: 9412) ➔ Sent PlayState HTTP 200 OK

      ⏳ Applying 150ms structural rate-limit protection delay...
      [PROCESSING] Index: 002/1650 | 'The Curse of Oak Island' ➔ Synchronizing...
      └── Continuing batch redistribution across all configured servers.

      🎉 [SUCCESS] Outward catch-up synchronization task completed across all servers!`)}
          </section>
        `;
}

export const HELP_TOPICS = [
  // ── Overview ──────────────────────────────────────────────────────
  {
    id: "getting-started",
    category: "Overview",
    title: "Getting Started",
    description: "Initial setup from admin sign-in to first webhook",
    badges: ["ADMIN_AUTH", "PLEX_URL", "EMBY_API_KEY", "JELLYFIN_API_KEY"],
    body: () => `
            <p>Plembfin is a self-hosted watch-state bridge. It listens for playback events from Plex, Emby, and Jellyfin via webhooks, records them in a local SQLite database, and propagates the watched or unwatched state to every other connected platform automatically. A background worker runs every minute so sync continues even when the dashboard is closed.</p>
            <p>Follow these steps to get from zero to a fully synchronised setup:</p>
            <ol>
              <li><b>Sign in</b> — Log in with your admin credentials (defaults to <code>admin</code> / <code>admin</code>; override with <code>ADMIN_USERNAME</code> / <code>ADMIN_PASSWORD</code>). If the default password is still set, you will be redirected to <a href="#" data-settings-link="general">Settings → General</a> to change it before proceeding.</li>
              <li><b>Add credentials</b> — Open <b>Settings → Apps</b> and fill in the server URL, token or API key, and user ID for each platform you use. Click <b>Save Configuration</b>.</li>
              <li><b>Configure webhooks</b> — Copy your webhook URL from <b>Settings → General</b> (it includes a secret token) and paste it into each media server. Per-server webhook steps are shown beside each platform in <a href="#" data-settings-link="apps">Settings → Apps</a>.</li>
              <li><b>Verify</b> — Open <b>Settings → Tools → System Integrity Check</b> and run the diagnostic. All probes should return green before you rely on live sync.</li>
              <li><b>Import history (optional)</b> — Use the Trakt History Importer in <b>Settings → Tools</b> to seed your local archive from a Trakt export, then run Full Sync Watchstates to push everything to your media servers.</li>
            </ol>
            <h3>How the system works</h3>
            <p>When a webhook event arrives at <code>/api/webhook</code>, Plembfin normalises the payload from whichever server sent it into a unified media object. The <code>phase</code> field drives the response: active playback upserts a live session; a completed watch inserts a <code>watch_history</code> record and triggers immediate propagation to the other platforms; an unplayed event deletes the record and marks it unwatched everywhere. A loop-detection store prevents echo loops when the propagation itself fires a webhook back.</p>
            <p>The scheduled worker runs every minute in-process. It polls active sessions, detects completed watches that crossed the 90% threshold, dispatches any outstanding sync jobs, and checks recent Plex items for unwatched removals — even when the dashboard is closed.</p>
          `,
  },

  // ── Credentials ───────────────────────────────────────────────────
  {
    id: "stats-review",
    category: "Overview",
    title: "Stats Reviews",
    description: "Year, month, and all-time watch reports",
    badges: [],
    body: () => `
            <p>The <b>Stats</b> page turns your local watch history into review reports. Use the Media, Period, and Range controls to switch between all-time, yearly, and monthly views for movies, TV shows, or both.</p>
            <p>The report starts with KPI cards for the selected range, then shows poster-ranked most-played items with play counts and share of activity. Supporting panels show the movie/TV split, playback platform breakdown, first/last plays, and watch activity.</p>
            <p>Click any poster card in the report to open that movie or TV show page.</p>
          `,
  },
  {
    id: "admin-auth",
    category: "Credentials",
    title: "Admin Sign-In",
    description: "Local username/password and API key",
    badges: ["ADMIN_AUTH"],
    body: () => `
            <p>Plembfin uses a local username and password to gate access to the dashboard, and an API key to gate webhooks and external integrations. Every <code>/api/*</code> request is verified server-side — unauthenticated requests are rejected before they touch the database.</p>
            ${adminTokenGuide()}
          `,
  },
  {
    id: "plex",
    category: "Credentials",
    title: "Plex",
    description: "Server URL and token extraction",
    badges: ["PLEX_URL", "PLEX_TOKEN"],
    body: () => `
            <p>Plembfin connects to your Plex server directly using its local or remote URL and a user token. The token identifies the account whose watch state is read and updated. Enter both in <b>Settings → Apps → Plex Setup</b> and click Save Configuration.</p>
            ${plexCredentialGuide()}
          `,
  },
  {
    id: "emby",
    category: "Credentials",
    title: "Emby",
    description: "API key, server URL, and user ID",
    badges: ["EMBY_API_KEY", "EMBY_USER_ID"],
    body: () => `
            <p>Plembfin uses the Emby HTTP API to read and write watch states. You need a server-level API key (not a user password) and the internal user ID of the account whose playstate should be synchronised. Enter these in <b>Settings → Apps → Emby Setup</b> and click Save Configuration.</p>
            ${embyCredentialGuide()}
          `,
  },
  {
    id: "jellyfin",
    category: "Credentials",
    title: "Jellyfin",
    description: "API key, server URL, and user ID",
    badges: ["JELLYFIN_API_KEY", "JELLYFIN_USER_ID"],
    body: () => `
            <p>Plembfin uses the Jellyfin HTTP API to read and write watch states. You need a server-level API key generated in the Jellyfin admin dashboard and the internal user ID of the account whose playstate should be synchronised. Enter these in <b>Settings → Apps → Jellyfin Setup</b> and click Save Configuration.</p>
            ${jellyfinCredentialGuide()}
          `,
  },

  // ── Webhooks ──────────────────────────────────────────────────────
  {
    id: "webhooks",
    category: "Webhooks",
    title: "Webhook Setup",
    description: "Configuring Plex, Emby, and Jellyfin to send events",
    badges: [],
    body: () => {
      const url = buildWebhookUrl();
      return `
              <p>Webhooks are how your media servers notify Plembfin the moment something is watched, paused, stopped, or marked as unplayed. Each server needs to be told where to send events — that is your unique webhook URL below. Plembfin accepts events from all three platforms on the same endpoint and normalises them into a single internal format.</p>
              <p>Your webhook URL (includes your secret token — keep it private):</p>
              ${snippet(url, "url")}
              ${webhookWarning()}
            `;
    },
  },

  // ── Sync ──────────────────────────────────────────────────────────
  {
    id: "sync-worker",
    category: "Sync",
    title: "Background Sync Worker",
    description: "Cron schedule, resume sync, and loop detection",
    badges: [],
    body: () => `
              <p>Plembfin keeps your watch states converged through two complementary mechanisms: immediate webhook propagation for real-time events, and a scheduled background worker for polling, catch-up, and recovery.</p>
              <h3>What the worker does each minute</h3>
              <ul>
                <li>Writes a heartbeat timestamp to <code>runtimeState</code> so you can confirm it is running.</li>
                <li>Polls Plex, Emby, and Jellyfin for active playback sessions and upserts live cache rows.</li>
                <li>Checks whether any active sessions have crossed the 90% watched threshold and commits completed watches to <code>watchHistory</code>.</li>
                <li>Dispatches outstanding sync jobs — records that were written but not yet propagated to all platforms.</li>
                <li>Checks recent Plex items for unwatched removals and propagates the unplayed state to Emby and Jellyfin.</li>
              </ul>
              <h3>Resume progress sync</h3>
              <p>When a stop or pause event arrives with a playback position below 90% of the item's duration, Plembfin stores the resume offset (in ticks) and pushes it to the other two platforms. Positions under one minute are ignored to avoid noise from accidental plays. The next time you open the item on a different platform it will offer to resume from where you left off.</p>
              <h3>Loop detection</h3>
              <p>When Plembfin propagates a watch event to Emby or Jellyfin, that server fires its own webhook back to Plembfin. The <code>loopStore</code> in-memory map tracks recently-processed events keyed by platform and media identifier. Any incoming webhook that matches a recently-dispatched event is detected as an echo and dropped before it can trigger another propagation round.</p>
              ${cronSyncGuide()}
            `,
  },
  {
    id: "sync-dashboard",
    category: "Sync",
    title: "Sync Dashboard",
    description: "Reading the job queue and sync history panels",
    badges: [],
    body: () => `
            <p>The <b>Settings → Sync</b> tab shows the current state of the sync queue and a log of recent propagation attempts. Use it to diagnose failures, check whether outstanding jobs are backed up, or confirm that a specific watched item was sent successfully.</p>
            <h3>Job queue</h3>
            <p>Each row in the sync jobs panel represents a <code>watchHistory</code> record that has at least one platform it still needs to reach. The row shows the media title, the target platform, the last attempt timestamp, and the current status. Rows clear automatically once all targets confirm success.</p>
            <p>Use <b>Force Sync</b> to immediately run the full sync pass on demand and stream the output to the terminal below the controls. Use <b>Run Cron Sync</b> to trigger the scheduled worker manually — useful for testing that the worker endpoint is reachable and that credentials are valid.</p>
            <h3>Sync history</h3>
            <p>The history panel shows the most recent sync dispatch results in reverse chronological order. Each row records the media title, the target platform, the HTTP status the platform returned, and whether the dispatch succeeded or failed. Persistent failures on a specific platform usually indicate a credential or connectivity problem — open <b>Settings → Tools → System Integrity Check</b> to probe that server directly.</p>
          `,
  },

  // ── Scripts ───────────────────────────────────────────────────────
  {
    id: "rebuild-playstate",
    category: "Scripts",
    title: "Rebuild Playstate Database",
    description: "Full reset and reimport from a Trakt export + live Plex state",
    badges: ["ADMIN_AUTH", "PLEX_TOKEN", "EMBY_API_KEY", "JELLYFIN_API_KEY"],
    body: () => rebuildPlaystateGuide(),
  },
  {
    id: "force-push-history",
    category: "Scripts",
    title: "Force Push History",
    description: "Replay the local watch history to Emby and Jellyfin",
    badges: ["EMBY_API_KEY", "EMBY_USER_ID", "JELLYFIN_API_KEY", "JELLYFIN_USER_ID"],
    body: () => forcePushHistoryGuide(),
  },
];

export const SETTINGS_DUPLICATED_HELP_TOPIC_IDS = new Set([
  "admin-auth",
  "plex",
  "emby",
  "jellyfin",
  "webhooks",
  "sync-worker",
  "sync-dashboard",
  "rebuild-playstate",
  "force-push-history",
]);

export function visibleHelpTopics() {
  return HELP_TOPICS.filter((topic) => !SETTINGS_DUPLICATED_HELP_TOPIC_IDS.has(topic.id));
}

export function renderSettingsInlineHelp() {
  const adminLoginHelp = document.getElementById("adminLoginHelp");
  if (adminLoginHelp) adminLoginHelp.innerHTML = adminTokenGuide();

  const plexHelp = document.getElementById("plexHelp");
  if (plexHelp) plexHelp.innerHTML = plexCredentialGuide() + plexWebhookSetup();

  const embyHelp = document.getElementById("embyHelp");
  if (embyHelp) embyHelp.innerHTML = embyCredentialGuide() + embyWebhookSetup();

  const jellyfinHelp = document.getElementById("jellyfinHelp");
  if (jellyfinHelp) jellyfinHelp.innerHTML = jellyfinCredentialGuide() + jellyfinWebhookSetup();

  const migrationHelp = document.getElementById("migrationHelp");
  if (migrationHelp) {
    migrationHelp.innerHTML = `
      <p class="tool-accordion-desc"><b>Backup &amp; Transfer:</b> Export native JSON database archives or import existing backups containing metadata, watch states, and user configurations.</p>
      <p class="tool-accordion-desc"><b>Trakt Importer:</b> Drag and drop CSV or JSON logs exported from Trakt.tv to populate your local database in bulk.</p>
      <details style="margin-top: var(--space-3);">
        <summary style="cursor: pointer; font-size: 0.82rem; font-weight: 700; color: var(--text); padding: var(--space-1) 0;">Export Plex History Guide</summary>
        <div style="margin-top: var(--space-2);">${exportPlexHistoryGuide()}</div>
      </details>
      <details style="margin-top: var(--space-2);">
        <summary style="cursor: pointer; font-size: 0.82rem; font-weight: 700; color: var(--text); padding: var(--space-1) 0;">Rebuild Database Guide</summary>
        <div style="margin-top: var(--space-2);">${rebuildPlaystateGuide()}</div>
      </details>
      <details style="margin-top: var(--space-2);">
        <summary style="cursor: pointer; font-size: 0.82rem; font-weight: 700; color: var(--text); padding: var(--space-1) 0;">Force Push History Guide</summary>
        <div style="margin-top: var(--space-2);">${forcePushHistoryGuide()}</div>
      </details>
    `;
  }
}
