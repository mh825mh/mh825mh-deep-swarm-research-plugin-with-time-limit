// src/config.ts
import { createConfigSchematics } from "@lmstudio/sdk";

/**
 * Application-wide config (shared across all chats): secrets and machine-local
 * infrastructure. Fields here are NOT part of the per-chat settings wall.
 */
export const globalConfigSchematics = createConfigSchematics()
  .field(
    "decodoApiToken",
    "string",
    {
      displayName: "Decodo Web Scraping API Token",
      subtitle:
        "Optional: Server-side fetch tier for TCP-blocked engines (e.g. DDG). Blank disables.",
      isProtected: true,
    },
    "",
  )
  .field(
    "flaresolverrUrl",
    "string",
    {
      displayName: "FlareSolverr URL",
      subtitle:
        "Optional: Local endpoint to bypass Cloudflare (e.g. http://127.0.0.1:8191/v1). Handled per-chat with web sandboxing.",
    },
    "",
  )
  .field(
    "searxngUrl",
    "string",
    {
      displayName: "SearXNG URL",
      subtitle:
        "Optional: Local SearXNG instance (e.g. http://127.0.0.1:8080). Defaults to a local endpoint; if unreachable the engine warns once and falls back to the public instance. Blank = public only.",
    },
    "http://127.0.0.1:8080",
  )
  .build();

/**
 * Per-chat config: only the controls a user is likely to change between
 * research jobs. Advanced / infrastructure / rarely-touched knobs were removed
 * from the schematic (their keys still work and default as described in the
 * plugin changelog).
 */
export const configSchematics = createConfigSchematics()
  .field(
    "researchDepth",
    "select",
    {
      displayName: "Research Depth",
      subtitle: "Rounds and budgets; deeper = more sources.",
      options: [
        { value: "shallow", displayName: "Shallow — 1 round, ~10-25 sources, fast" },
        { value: "standard", displayName: "Standard — 3 rounds, ~30-60 sources (recommended)" },
        { value: "deep", displayName: "Deep — 5 rounds, ~60-120 sources, thorough" },
        { value: "deeper", displayName: "Deeper — 10 rounds, ~100-200+ sources, very thorough" },
        { value: "exhaustive", displayName: "Exhaustive — 15 rounds, 200+ sources, maximum depth" },
      ],
    },
    "standard",
  )
  .field(
    "enableLocalSources",
    "select",
    {
      displayName: "Data Sources",
      subtitle: "WARNING: Local RAG can consume your entire budget. Enable only for your internal documents.",
      options: [
        { value: "off", displayName: "Web only (Recommended)" },
        { value: "local", displayName: "Local documents only" },
        { value: "web_local", displayName: "Local documents and web" },
      ],
    },
    "off",
  )
  .field(
    "maxSessionMinutes",
    "numeric",
    {
      displayName: "Max Session Time (minutes)",
      subtitle:
        "Wall-clock cap per run (min of this and the LLM Call Mode runtime cap). 0 = use the LLM Call Mode runtime cap.",
      min: 0,
      max: 240,
      int: true,
      slider: { step: 5, min: 0, max: 240 },
    },
    30,
  )
  .field(
    "enableAIPlanning",
    "select",
    {
      displayName: "AI Query Planning",
      subtitle: "Use the loaded model for smarter queries and synthesis",
      options: [
        { value: "on", displayName: "On — AI-powered (best quality)" },
        { value: "off", displayName: "Off — dimension-based fallback (faster start)" },
      ],
    },
    "on",
  )
  .field(
    "enableLinkFollowing",
    "select",
    {
      displayName: "Link Following",
      subtitle: "Workers follow relevant in-page links (like citations)",
      options: [
        { value: "on", displayName: "On — follow top links (recommended)" },
        { value: "off", displayName: "Off — search results only" },
      ],
    },
    "on",
  )
  .field(
    "timeRange",
    "select",
    {
      displayName: "Search Time Range",
      subtitle: "Filter results by publication date",
      options: [
        { value: "all", displayName: "All time (default)" },
        { value: "year", displayName: "Past year" },
        { value: "month", displayName: "Past month" },
        { value: "week", displayName: "Past week" },
        { value: "day", displayName: "Past 24 hours" },
      ],
    },
    "all",
  )
  .field(
    "enableAcademicAPIs",
    "select",
    {
      displayName: "Academic APIs (OpenAlex, Crossref, arXiv)",
      subtitle: "Query academic databases directly for papers",
      options: [
        { value: "on", displayName: "On" },
        { value: "off", displayName: "Off" },
      ],
    },
    "off",
  )
  .field(
    "enableYouTube",
    "select",
    {
      displayName: "YouTube Transcript Search",
      subtitle: "Search YouTube and extract video transcripts",
      options: [
        { value: "on", displayName: "On" },
        { value: "off", displayName: "Off" },
      ],
    },
    "off",
  )
  .field(
    "enableReferenceSearch",
    "select",
    {
      displayName: "Encyclopedia Search",
      subtitle: "Prioritize Grokipedia, Encyclopedia.com, and Britannica over Wikipedia",
      options: [
        { value: "on", displayName: "On" },
        { value: "off", displayName: "Off" },
      ],
    },
    "on",
  )
  .field(
    "cacheDuration",
    "select",
    {
      displayName: "Persistent Cache Duration",
      subtitle: "How long visited pages are kept in the local cache",
      options: [
        { value: "30", displayName: "30 Days" },
        { value: "90", displayName: "90 Days" },
        { value: "180", displayName: "6 Months" },
        { value: "365", displayName: "12 Months" },
        { value: "730", displayName: "24 Months" },
      ],
    },
    "30",
  )
  .field(
    "includeReasoningAudit",
    "boolean",
    {
      displayName: "Include Reasoning Audit",
      subtitle:
        "Append a collapsible 'Swarm Reasoning & Verification Trace' section to the final report.",
    },
    true,
  )
  .build();