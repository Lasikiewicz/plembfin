export const site = {
  name: "Plembfin",
  title: "Plembfin - One local archive for every screen.",
  description:
    "Plembfin is the self-hosted bridge that remembers what you watched, keeps Plex, Emby, Jellyfin, Trakt, and metadata aligned, and gives you private discovery and media lists.",
  url: "https://plembfin.com",
  repository: "https://github.com/Lasikiewicz/plembfin",
  repositoryDocs: "https://github.com/Lasikiewicz/plembfin/tree/main/docs",
  discord: "https://discord.gg/7ZmEGKcRC5",
  reddit: "https://www.reddit.com/r/plembfin/",
};

export const integrations = [
  { name: "Plex", role: "Media server", icon: "/assets/icons/plex.svg" },
  { name: "Emby", role: "Media server", icon: "/assets/icons/emby.svg" },
  { name: "Jellyfin", role: "Media server", icon: "/assets/icons/jellyfin.svg" },
  { name: "Trakt", role: "Watch history", icon: "/assets/icons/trakt.svg" },
  { name: "TMDB", role: "Metadata and artwork", icon: "/assets/icons/tmdb.svg" },
  { name: "TheTVDB", role: "Episodes and air dates", icon: "/assets/icons/tvdb.svg" },
  { name: "Fanart.tv", role: "Artwork fallback", icon: "/assets/icons/fanart.svg" },
  { name: "IMDb", role: "Rating links", icon: "/assets/icons/imdb.svg" },
];

export const features = [
  {
    title: "Canonical sync",
    text: "Two-way sync keeps watched state aligned across every connected app, with auto-reconciliation when something drifts.",
  },
  {
    title: "Cross-platform resume",
    text: "Pause on one server and pick up right where you left off on another.",
  },
  {
    title: "Rewatch tracking",
    text: "Full multi-watch history logging with deduplication that preserves genuine repeat viewings.",
  },
  {
    title: "Discovery rails",
    text: "Browse current TMDB-backed movie and TV feeds, filter them by type or genre, and open a title before it is in your local library.",
  },
  {
    title: "Private media shelves",
    text: "Keep a personal watchlist, 1–10 ratings, and custom lists alongside the shared library without turning your archive into a public profile.",
  },
  {
    title: "Sync Activity hub",
    text: "A live status indicator and activity stream showing sync origins, destinations, delivery results, and targeted retries.",
  },
  {
    title: "Rich analytics and stats",
    text: "All-time and period reports, top shows, and platform playback distribution.",
  },
  {
    title: "Automated backups",
    text: "Built-in daily local backups, with optional scheduled offsite backups to Backblaze B2.",
  },
  {
    title: "Self-hosted and private",
    text: "Runs entirely on your own hardware with dedicated SQLite storage and full data ownership.",
  },
  {
    title: "Progressive Web App",
    text: "Installable on iOS, Android, macOS, and Windows with a native app experience.",
  },
];

export const featureStories = [
  {
    id: "sync",
    title: "One watch. Every screen.",
    text: "Plembfin keeps a local canonical record of watched state, resume progress, and rewatches, then distributes the right change to every connected service.",
    bullets: ["Two-way watched and unwatched sync", "Cross-platform resume progress", "Rewatch history without duplicate noise"],
    imageDark: "/assets/app-captures/dashboard-cleared-dark.png",
    imageLight: "/assets/app-captures/dashboard-cleared-light.png",
    imageAlt: "Plembfin dashboard showing the watch archive across TV and movie history",
    link: "/docs/concepts/",
    linkLabel: "Understand the sync model",
  },
  {
    id: "observe",
    title: "Know what is happening.",
    text: "See live playback, the next episode worth starting, recently watched TV and movies, upcoming episodes, and long-term viewing patterns in one focused app.",
    bullets: ["Now Playing refreshes within seconds", "Up Next with provider availability and Watch Now links", "History, calendar, and useful statistics"],
    imageDark: "/assets/app-captures/now-playing-dark.png",
    imageLight: "/assets/app-captures/now-playing-light.png",
    imageAlt: "Plembfin Now Playing view showing three active playback sessions",
    link: "/docs/dashboard/",
    linkLabel: "Read the dashboard guide",
  },
  {
    id: "library",
    title: "Make your library legible.",
    text: "Search local media and external providers together. Open rich details, follow collections, inspect people, and request missing titles through Seerr.",
    bullets: ["Poster-first movie and TV libraries", "TMDB and TheTVDB enrichment", "Collections, people, reviews, and deep links"],
    imageDark: "/assets/app-captures/tvshows-dark.png",
    imageLight: "/assets/app-captures/tvshows-light.png",
    imageAlt: "Plembfin TV Shows library with poster grids, watch progress, and filters",
    link: "/docs/libraries/",
    linkLabel: "Browse libraries and actions",
  },
  {
    id: "discover",
    title: "Find something worth watching.",
    text: "Discover turns TMDB's current feeds into a browsable set of trending, now-playing, and airing-today rails, with type and genre filters when you want to narrow the signal.",
    bullets: ["Trending movie and TV rails", "Movie, TV, and genre filters", "Open a title, rate it, watchlist it, or add it to a custom list"],
    imageDark: "/assets/app-captures/discover-dark.png",
    imageLight: "/assets/app-captures/discover-light.png",
    imageAlt: "Plembfin Discover page showing trending movie and TV rails",
    link: "/docs/discover/",
    linkLabel: "Explore Discover",
  },
  {
    id: "personal",
    title: "Keep the queue yours.",
    text: "Watchlist, ratings, and custom lists are private local tools for deciding what matters to you, without mixing personal intent into canonical watch history.",
    bullets: ["Save movies, shows, and episodes for later", "Rate media from one to ten", "Create lists for any collection you want to keep"],
    imageDark: "/assets/app-captures/watchlist-dark.png",
    imageLight: "/assets/app-captures/watchlist-light.png",
    imageAlt: "Plembfin Watchlist page showing saved media cards and personal actions",
    link: "/docs/personal-media/",
    linkLabel: "Read the personal media guide",
  },
  {
    id: "ownership",
    title: "Keep every change explainable.",
    text: "A local archive is only useful when you can understand what happened. Plembfin keeps source, destination, outcome, and retry context close to the record.",
    bullets: ["Per-destination delivery results", "Targeted retries instead of blind full syncs", "Operational evidence for recovery work"],
    imageDark: "/assets/app-captures/sync-activity-dark.png",
    imageLight: "/assets/app-captures/sync-activity-light.png",
    imageAlt: "Plembfin Sync Activity view showing events, sources, and delivery state",
    link: "/docs/sync-tools/",
    linkLabel: "Read the sync activity guide",
  },
];

export const comparison = {
  columns: ["Plembfin", "A public tracking hub"],
  rows: [
    {
      label: "Primary focus",
      values: [
        "Watch-history accuracy across every connected media server",
        "Public profile, ratings, discovery, and social features",
      ],
    },
    {
      label: "Sync visibility",
      values: [
        "Sync Activity records origin, destination, delivery result, and supports targeted per-destination retries",
        "Webhook-based scrobbling with a plugin-level log",
      ],
    },
    {
      label: "Media requests",
      values: [
        "Through Seerr (Overseerr or Jellyseerr)",
        "Direct integration with Radarr and Sonarr",
      ],
    },
    {
      label: "Kodi support",
      values: ["Not supported", "Official addon available"],
    },
    {
      label: "Sign-in",
      values: [
        "Local administrator account",
        "OIDC/SSO providers such as Authelia, Authentik, or Keycloak",
      ],
    },
    {
      label: "Social features",
      values: [
        "Private watchlist, ratings, and custom lists; no public profile",
        "Public ratings, personal lists, and social features built in",
      ],
    },
  ],
};

export const docsNav = [
  {
    label: "Start here",
    description: "Get a new instance running and verify its first connection.",
    items: [
      {
        slug: "getting-started",
        label: "Getting started",
        description: "Install Plembfin and complete the first-run setup.",
        children: [
          { id: "before-you-install", label: "Before you install" },
          { id: "install-with-docker-compose", label: "Install with Docker Compose" },
          { id: "install-with-node-js", label: "Install with Node.js" },
          { id: "claim-the-instance", label: "Claim the instance" },
          { id: "complete-the-guided-setup", label: "Complete the guided setup" },
          { id: "connect-the-first-media-server", label: "Connect the first media server" },
          { id: "confirm-the-first-sync", label: "Confirm the first sync" },
          { id: "what-to-do-next", label: "What to do next" },
        ],
      },
    ],
  },
  {
    label: "Understand the app",
    description: "Learn how Plembfin turns events into a durable local archive.",
    items: [
      {
        slug: "concepts",
        label: "The sync model",
        description: "How Plembfin becomes the local source of truth.",
        children: [
          { id: "the-canonical-record", label: "The canonical record" },
          { id: "the-event-lifecycle", label: "The event lifecycle" },
          { id: "watched-state-and-resume-progress", label: "Watched state and resume progress" },
          { id: "rewatches-and-duplicate-protection", label: "Rewatches and duplicate protection" },
          { id: "webhooks-polling-and-scheduled-work", label: "Webhooks, polling, and scheduled work" },
          { id: "read-sync-activity", label: "Read Sync Activity" },
          { id: "important-boundaries", label: "Important boundaries" },
        ],
      },
    ],
  },
  {
    label: "Dashboard and libraries",
    description: "Learn the screens used for daily browsing, playback, and history review.",
    items: [
      {
        slug: "dashboard",
        label: "Dashboard",
        description: "Now Playing, Up Next, watch history rows, and the default Card View.",
        children: [
          { id: "page-structure", label: "Page structure" },
          { id: "now-playing", label: "Now Playing" },
          { id: "up-next", label: "Up Next" },
          { id: "part-watched", label: "Part Watched" },
          { id: "tv-and-movie-history", label: "TV and movie history" },
          { id: "dashboard-history-cards", label: "Dashboard history cards" },
          { id: "a-useful-daily-check", label: "A useful daily check" },
        ],
      },
      {
        slug: "libraries",
        label: "Movies and TV Shows",
        description: "Libraries, filters, progress, and the poster three-dot menu.",
        children: [
          { id: "shared-library-controls", label: "Shared library controls" },
          { id: "movies", label: "Movies" },
          { id: "tv-shows", label: "TV Shows" },
          { id: "the-poster-three-dot-menu", label: "The poster three-dot menu" },
          { id: "choosing-the-right-action", label: "Choosing the right action" },
        ],
      },
    ],
  },
  {
    label: "Media and discovery",
    description: "Browse current feeds, keep private media lists, inspect titles, correct identity, choose artwork, and control optional detail sections.",
    items: [
      {
        slug: "discover",
        label: "Discover",
        description: "Browse TMDB-backed rails, filters, and title actions.",
        children: [
          { id: "discovery-rails", label: "Discovery rails" },
          { id: "type-and-genre-filters", label: "Type and genre filters" },
          { id: "open-and-save-a-title", label: "Open and save a title" },
        ],
      },
      {
        slug: "personal-media",
        label: "Personal media",
        description: "Save, score, and group titles with private local media pages.",
        children: [
          { id: "personal-media-at-a-glance", label: "Personal media at a glance" },
          { id: "choose-the-right-page", label: "Choose the right page" },
          { id: "actions-from-a-title", label: "Actions from a title" },
          { id: "privacy-and-watch-state-boundaries", label: "Privacy and watch-state boundaries" },
        ],
      },
      {
        slug: "watchlist",
        label: "Watchlist",
        description: "Save movies, shows, and episodes for later.",
        children: [
          { id: "open-watchlist", label: "Open Watchlist" },
          { id: "saved-media-cards", label: "Saved media cards" },
          { id: "add-a-title", label: "Add a title" },
          { id: "rate-or-remove-a-card", label: "Rate or remove a card" },
          { id: "more-options-and-detail-actions", label: "More options and detail actions" },
          { id: "empty-state-and-privacy", label: "Empty state and privacy" },
        ],
      },
      {
        slug: "ratings",
        label: "Ratings",
        description: "Keep private 1–10 scores for movies, shows, and episodes.",
        children: [
          { id: "open-ratings", label: "Open Ratings" },
          { id: "rate-a-title-from-a-card", label: "Rate a title from a card" },
          { id: "rate-from-a-detail-page", label: "Rate from a detail page" },
          { id: "change-or-remove-a-rating", label: "Change or remove a rating" },
          { id: "episode-identity-and-groups", label: "Episode identity and groups" },
          { id: "relationship-to-watched-state", label: "Relationship to watched state" },
        ],
      },
      {
        slug: "custom-lists",
        label: "Custom Lists",
        description: "Create private named collections and manage membership.",
        children: [
          { id: "open-custom-lists", label: "Open Custom Lists" },
          { id: "create-and-select-a-list", label: "Create and select a list" },
          { id: "add-a-movie-or-tv-show", label: "Add a movie or TV show" },
          { id: "remove-membership", label: "Remove membership" },
          { id: "delete-a-list", label: "Delete a list" },
          { id: "privacy-and-empty-states", label: "Privacy and empty states" },
        ],
      },
      {
        slug: "media-details",
        label: "Media details and actions",
        description: "Watch dates, Fix Match, artwork, sync actions, and related content.",
        children: [
          { id: "page-actions", label: "Page actions" },
          { id: "what-the-page-can-contain", label: "What the page can contain" },
          { id: "tv-detail-controls", label: "TV detail controls" },
          {
            id: "watch-actions-and-dates",
            label: "Watch actions and dates",
            children: [
              { id: "mark-watched", label: "Mark watched" },
              { id: "mark-unwatched", label: "Mark unwatched" },
              { id: "edit-watch-date", label: "Edit watch date" },
            ],
          },
          {
            id: "fix-match",
            label: "Fix Match",
            children: [
              { id: "fix-a-movie-match", label: "Fix a movie match" },
              { id: "fix-a-tv-show-match", label: "Fix a TV show match" },
            ],
          },
          { id: "edit-images", label: "Edit Images" },
          {
            id: "personal-lists-and-the-tools-menu",
            label: "Personal lists and the Tools menu",
            children: [
              { id: "personal-actions", label: "Personal actions" },
              { id: "tools-menu", label: "Tools menu" },
              { id: "force-sync", label: "Force Sync" },
              { id: "info", label: "Info" },
              { id: "edit-images-from-tools", label: "Edit Images from Tools" },
              { id: "fix-match-from-tools", label: "Fix Match from Tools" },
              { id: "delete", label: "Delete" },
              { id: "merge", label: "Merge" },
            ],
          },
          { id: "related-content-and-lightboxes", label: "Related content and lightboxes" },
        ],
      },
      {
        slug: "features",
        label: "Features and pages",
        description: "A complete guide to every dashboard, library, detail, search, and sync workflow.",
        children: [
          { id: "navigation-and-global-controls", label: "Navigation and global controls" },
          {
            id: "dashboard",
            label: "Dashboard",
            children: [
              { id: "now-playing", label: "Now Playing" },
              { id: "up-next", label: "Up Next" },
              { id: "part-watched", label: "Part Watched" },
              { id: "dashboard-history", label: "Dashboard history" },
            ],
          },
          { id: "movies", label: "Movies", children: [{ id: "poster-three-dot-menu", label: "Poster three-dot menu" }] },
          { id: "tv-shows", label: "TV Shows" },
          { id: "upcoming", label: "Upcoming" },
          { id: "discover", label: "Discover" },
          {
            id: "personal-media",
            label: "Personal media",
            children: [
              { id: "watchlist", label: "Watchlist" },
              { id: "ratings", label: "Ratings" },
              { id: "custom-lists", label: "Custom Lists" },
            ],
          },
          {
            id: "history-and-global-search",
            label: "History and global Search",
            children: [
              { id: "history", label: "History" },
              { id: "global-search", label: "Global Search" },
            ],
          },
          { id: "stats", label: "Stats" },
          {
            id: "media-details-and-editing",
            label: "Media details and editing",
            children: [
              { id: "watch-actions-and-watch-dates", label: "Watch actions and watch dates" },
              { id: "fix-match", label: "Fix Match" },
              { id: "edit-images", label: "Edit Images" },
              { id: "more-menu", label: "More menu" },
              { id: "posters-galleries-trailers-and-people", label: "Posters, galleries, trailers, and people" },
            ],
          },
          {
            id: "appearance-menu",
            label: "Appearance menu",
            children: [
              { id: "media-detail-options", label: "Media-detail options" },
            ],
          },
          { id: "sync-activity", label: "Sync Activity" },
          { id: "safe-daily-workflows", label: "Safe daily workflows" },
        ],
      },
      {
        slug: "appearance",
        label: "Appearance",
        description: "Theme and media-detail visibility controls.",
        children: [
          { id: "theme", label: "Theme" },
          { id: "media-detail-options", label: "Media-detail options" },
          { id: "change-a-setting", label: "Change a setting" },
        ],
      },
    ],
  },
  {
    label: "Connect services",
    description: "Connect media servers, trackers, request tools, and metadata providers.",
    items: [
      {
        slug: "integrations",
        label: "Integrations",
        description: "Connect media servers, Trakt, Seerr, and metadata providers.",
        children: [
          { id: "media-servers", label: "Media servers" },
          { id: "the-connection-checklist", label: "The connection checklist" },
          { id: "plex", label: "Plex" },
          { id: "emby", label: "Emby" },
          { id: "jellyfin", label: "Jellyfin" },
          { id: "trakt", label: "Trakt" },
          { id: "seerr", label: "Seerr" },
          { id: "metadata-and-artwork-providers", label: "Metadata and artwork providers" },
          { id: "verify-a-connection-without-guessing", label: "Verify a connection without guessing" },
        ],
      },
    ],
  },
  {
    label: "Configure the instance",
    description: "Use every settings group, control, maintenance tool, backup, and recovery action.",
    items: [
      {
        slug: "settings",
        label: "Settings",
        description: "Every settings group, control, maintenance tool, backup, and recovery action.",
        children: [
          { id: "settings-map", label: "Settings map" },
          {
            id: "general",
            label: "General",
            children: [
              { id: "account", label: "Account" },
              { id: "system-integrity", label: "System Integrity" },
              { id: "storage-and-cache", label: "Storage and cache" },
            ],
          },
          {
            id: "media-servers",
            label: "Media servers",
            children: [
              { id: "plex", label: "Plex" },
              { id: "emby", label: "Emby" },
              { id: "jellyfin", label: "Jellyfin" },
              { id: "connection-mode-rules", label: "Connection mode rules" },
            ],
          },
          {
            id: "webhooks",
            label: "Webhooks",
            children: [
              { id: "setup-guides", label: "Setup guides" },
              { id: "webhook-secret", label: "Webhook secret" },
            ],
          },
          {
            id: "connections",
            label: "Connections",
            children: [
              { id: "trakt", label: "Trakt" },
              { id: "seerr", label: "Seerr" },
            ],
          },
          {
            id: "metadata",
            label: "Metadata",
            children: [
              { id: "metadata-providers", label: "Metadata providers" },
              { id: "refresh-all-metadata", label: "Refresh all metadata" },
              { id: "refresh-tmdb-metadata", label: "Refresh TMDB metadata" },
              { id: "refresh-tvdb-metadata", label: "Refresh TVDB metadata" },
            ],
          },
          {
            id: "sync",
            label: "Sync",
            children: [
              { id: "sync-tuning", label: "Sync Tuning" },
              { id: "sync-tools", label: "Sync Tools" },
              { id: "sync-issues-and-match-report", label: "Sync Issues and Match Report" },
              { id: "sync-history", label: "Sync History" },
            ],
          },
          {
            id: "backup",
            label: "Backup",
            children: [
              { id: "local-backups", label: "Local backups" },
              { id: "remote-backups", label: "Remote backups" },
            ],
          },
          { id: "restore", label: "Restore" },
          {
            id: "tools",
            label: "Tools",
            children: [
              { id: "guided-setup", label: "Guided Setup" },
              { id: "database-repairs", label: "Database Repairs" },
              { id: "library-rebuilds-and-backfills", label: "Library Rebuilds and Backfills" },
              { id: "wipe-data", label: "Wipe Data" },
            ],
          },
          { id: "logs", label: "Logs" },
          { id: "about", label: "About" },
        ],
      },
    ],
  },
  {
    label: "Sync and maintain",
    description: "Understand delivery results and safely maintain or recover the archive.",
    items: [
      {
        slug: "sync-tools",
        label: "Sync Activity and tools",
        description: "Results, retries, Force Sync, match reports, and operational evidence.",
        children: [
          { id: "read-an-activity-row", label: "Read an activity row" },
          { id: "retry-one-result", label: "Retry one result" },
          { id: "retry-all-failed", label: "Retry all failed" },
          {
            id: "settings-sync-tools",
            label: "Settings sync tools",
            children: [
              { id: "repair-recent-items", label: "Repair Recent Items" },
              { id: "full-sync-watchstates", label: "Full Sync Watchstates" },
              { id: "force-sync", label: "Force Sync" },
            ],
          },
          { id: "sync-issues-and-match-report", label: "Sync Issues and Match Report" },
          { id: "sync-history-and-logs", label: "Sync History and Logs" },
        ],
      },
      {
        slug: "operations",
        label: "Backups and operations",
        description: "Backups, imports, security, and maintenance.",
        children: [
          { id: "backups", label: "Backups" },
          { id: "restore-safely", label: "Restore safely" },
          { id: "import-history", label: "Import history" },
          { id: "routine-maintenance", label: "Routine maintenance" },
          { id: "security-basics", label: "Security basics" },
          { id: "updates-and-release-channels", label: "Updates and release channels" },
          { id: "pwa-and-local-operation", label: "PWA and local operation" },
        ],
      },
    ],
  },
  {
    label: "Fix a problem",
    description: "Start with the symptom and follow exact, feature-specific recovery steps.",
    items: [
      {
        slug: "troubleshooting",
        label: "Troubleshooting",
        description: "Start with the symptom and follow the fix.",
        children: [
          { id: "a-quick-diagnostic-order", label: "A quick diagnostic order" },
          { id: "now-playing-is-empty-or-stale", label: "Now Playing is empty or stale" },
          { id: "part-watched-is-missing-or-has-the-wrong-progress", label: "Part Watched is missing or has the wrong progress" },
          { id: "discover-is-empty-or-unavailable", label: "Discover is empty or unavailable" },
          { id: "watchlist-rating-or-list-action-did-not-update", label: "Watchlist, rating, or list action did not update" },
          { id: "fix-match-returns-no-useful-result", label: "Fix Match returns no useful result" },
          { id: "the-poster-three-dot-menu-is-missing-or-does-nothing", label: "The poster three-dot menu is missing or does nothing" },
          { id: "appearance-settings-are-missing-or-do-not-persist", label: "Appearance settings are missing or do not persist" },
          { id: "refresh-metadata-did-not-update-a-title", label: "Refresh Metadata did not update a title" },
          { id: "a-watched-event-was-not-recorded", label: "A watched event was not recorded" },
          { id: "it-recorded-but-did-not-reach-another-service", label: "It recorded but did not reach another service" },
          { id: "resume-progress-did-not-carry-over", label: "Resume progress did not carry over" },
          { id: "posters-or-metadata-are-missing", label: "Posters or metadata are missing" },
          { id: "webhook-returns-401", label: "Webhook returns 401" },
          { id: "trakt-changes-keep-coming-back", label: "Trakt changes keep coming back" },
          { id: "settings-or-config-did-not-save", label: "Settings or config did not save" },
          { id: "the-scheduler-is-not-running", label: "The scheduler is not running" },
          { id: "when-to-stop-and-restore", label: "When to stop and restore" },
        ],
      },
    ],
  },
];

// The documentation sidebar mirrors the product shell. App-level pages stay
// prominent, while the focused guide links sit beneath Movies, TV Shows, and
// Settings just as their related views do in Plembfin.
export const docsSidebarNav = [
  { id: "dashboard", label: "Dashboard", slug: "dashboard" },
  {
    id: "movies",
    label: "Movies",
    slug: "movies",
    children: [{ slug: "movies/media-page", label: "Movies media page" }],
  },
  {
    id: "tv-shows",
    label: "TV Shows",
    slug: "tv-shows",
    children: [{ slug: "tv-shows/media-page", label: "TV Shows media page" }],
  },
  { id: "upcoming", label: "Upcoming", slug: "upcoming" },
  { id: "discover", label: "Discover", slug: "discover" },
  {
    id: "personal-media",
    label: "Personal media",
    slug: "personal-media",
    children: [
      { slug: "watchlist", label: "Watchlist" },
      { slug: "ratings", label: "Ratings" },
      { slug: "custom-lists", label: "Custom Lists" },
    ],
  },
  { id: "history", label: "History", slug: "history-search" },
  { id: "stats", label: "Stats", slug: "stats" },
  {
    id: "settings",
    label: "Settings",
    slug: "settings",
    children: [
      { slug: "settings/general", label: "General" },
      { slug: "settings/media-servers", label: "Media servers" },
      { slug: "settings/webhooks", label: "Webhooks" },
      { slug: "settings/connections", label: "Connections" },
      { slug: "settings/metadata", label: "Metadata" },
      { slug: "settings/sync", label: "Sync" },
      { slug: "settings/backup", label: "Backup" },
      { slug: "settings/restore", label: "Restore" },
      { slug: "settings/tools", label: "Tools" },
      { slug: "settings/logs", label: "Logs" },
      { slug: "settings/about", label: "About" },
    ],
  },
  { id: "sync-activity", label: "Sync Activity", slug: "sync-tools" },
  {
    id: "guides",
    label: "Guides",
    children: [
      { slug: "getting-started", label: "Getting started" },
      { slug: "concepts", label: "The sync model" },
      { slug: "navigation", label: "Navigation and global controls" },
      { slug: "media-details", label: "Media details and actions" },
      { slug: "discover", label: "Discover" },
      { slug: "personal-media", label: "Personal media overview" },
      { slug: "watchlist", label: "Watchlist" },
      { slug: "ratings", label: "Ratings" },
      { slug: "custom-lists", label: "Custom Lists" },
      { slug: "integrations", label: "Integrations" },
      { slug: "operations", label: "Backups and operations" },
      { slug: "safe-daily-workflows", label: "Safe daily workflows" },
      { slug: "troubleshooting", label: "Troubleshooting" },
    ],
  },
];

// Article pagination order. Page headings and their child sections belong in each
// guide's right-hand outline rather than becoming entries in this list.
export const docsPageNav = [
  { slug: "getting-started", label: "Getting started" },
  { slug: "concepts", label: "The sync model" },
  { slug: "navigation", label: "Navigation and global controls" },
  { slug: "dashboard", label: "Dashboard" },
  { slug: "movies", label: "Movies" },
  { slug: "movies/media-page", label: "Movies media page" },
  { slug: "tv-shows", label: "TV Shows" },
  { slug: "tv-shows/media-page", label: "TV Shows media page" },
  { slug: "upcoming", label: "Upcoming" },
  { slug: "discover", label: "Discover" },
  { slug: "personal-media", label: "Personal media overview" },
  { slug: "watchlist", label: "Watchlist" },
  { slug: "ratings", label: "Ratings" },
  { slug: "custom-lists", label: "Custom Lists" },
  { slug: "history-search", label: "History and global Search" },
  { slug: "stats", label: "Stats" },
  { slug: "media-details", label: "Media details and editing" },
  { slug: "appearance", label: "Appearance menu" },
  { slug: "integrations", label: "Integrations" },
  { slug: "settings", label: "Settings" },
  { slug: "settings/general", label: "General" },
  { slug: "settings/media-servers", label: "Media servers" },
  { slug: "settings/webhooks", label: "Webhooks" },
  { slug: "settings/connections", label: "Connections" },
  { slug: "settings/metadata", label: "Metadata" },
  { slug: "settings/sync", label: "Sync" },
  { slug: "settings/backup", label: "Backup" },
  { slug: "settings/restore", label: "Restore" },
  { slug: "settings/tools", label: "Tools" },
  { slug: "settings/logs", label: "Logs" },
  { slug: "settings/about", label: "About" },
  { slug: "sync-tools", label: "Sync Activity" },
  { slug: "operations", label: "Backups and operations" },
  { slug: "safe-daily-workflows", label: "Safe daily workflows" },
  { slug: "troubleshooting", label: "Troubleshooting" },
];

export const flatDocs = docsPageNav;
