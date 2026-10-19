# Changelog

All notable changes to `lms-plugin-deep-swarm-research`, newest first. See `README.md` for setup and configuration.

---

## 🚀 What's New in v5.10.0?

Latency, zero-source resilience, and KV-cache efficiency for local Qwen-class
models.

* **Qwen 3.8 fast-call mode (`optimizeForQwen38`):** the gatekeeper, critic, and
  query-mutation micro-calls now prefill an empty `<think>\n</think>\n` block and
  append `/no_think`, so a one-word YES/NO or a short verdict can't be truncated
  inside a reasoning trace. Planner and synthesis keep full reasoning.
* **Tier-0 keyless JSON pre-seeder (`seedFromTierZeroJsonApis`):** OpenAlex and
  the Wikipedia REST API run concurrently (hard <3.5s cap) at the start of the
  external layers, before DDG/Bing/SearXNG, and promote verified reference cards
  straight into the evidence ledger. Zero-source runs can no longer stall the
  watchdog.
* **Intra-page BM25 windowing (`extractTopBm25Windows`):** evidence excerpts are
  now the top BM25-scored paragraphs across the whole page (reading order
  preserved, with heading/number boosts) instead of a blind top-of-page slice, so
  mid-article data reaches the critic and synthesis.
* **Topic-adaptive fallback planner (`selectAdaptiveFallbackDimensions`):** when
  LLM planning is unavailable the deterministic path emits the top 4
  topic-matched dimensions (scientific / technical / market / generic) instead of
  a blind 12-dimension dump.
* **KV-cache-pinned system prefix (`buildKvCachePinnedMessages`):** the planner,
  critic, and synthesis now share a byte-identical `STATIC_SWARM_SYSTEM_PREFIX`
  (plus the run's `[DOMAIN RUBRIC]`) so LM Studio reuses its prefix KV cache
  across sequential calls.
* **In-run singleflight URL dedupe (`SingleflightUrlFetcher`):** concurrent
  workers fetching the same URL collapse into one HTTP / FlareSolverr / Decodo
  request; savings are logged per run and the cache resets every run.
* **Pre-fetch SERP snippet gate (`shouldFetchSerpCandidate`):** login/cart/tag
  URLs and results with no core-topic term are dropped by title + snippet before
  any page fetch (followed in-page links are exempt).
* **Skill-pack fallback (`resolveSkillPackWithFallback`):** unmatched domain tags
  now fall back to a topic-classified pack (academic / market / policy) instead
  of leaving the run with `[SKILL] none`.

---

## 🚀 What's New in v5.9.1?

Local-model hardening: less wasted inference, fewer stalls, and no model prose
reaching structured output.

* **Flat critic wire schema:** the LLM-facing critic schema is now a single level
  of primitives — `cardId, onTopic, hasDate, contradictsLedger, claimStrength:
  "high"|"medium"|"low", extractedClaim, sourceUrl` — with no nested objects and
  no free-form prose. The internal `CriticVerdict` is reconstructed
  deterministically (`contradictsLedger` is attributed to the accepted-ledger
  window ids, `hasDate` → dated/undated), so small Qwen-class models emit valid
  structured output far more reliably.
* **Tiered lexical gate before the critic:** a deterministic `lexicalScore()`
  (topic-token coverage + saturating substance) ranks cards, the strongest are
  graded first, and a parse failure only triggers the single bounded retry when
  the batch contains a top-tier card. Low-value failures fall back to
  deterministic verdicts instead of burning the synthesis reserve.
* **Truncation-proof `<think>` parsing:** the JSON extractor now strips both
  complete `<think>…</think>` blocks and unterminated `<think>…` prefixes left
  when max tokens cut reasoning off mid-stream.
* **Budget-gated uncertainty mining:** the DeepThink mining wave is now skipped
  once more than 65% of the hard runtime has elapsed, or when fewer than
  `activeWorkers + 3` LLM calls remain — and mined queries are deduped against
  everything already searched using Jaccard token overlap (≥ 0.75).
* **Strict Tier-1 fetch timeout:** direct HTTP fetches now time out at a hard
  4,500 ms (`constants.ts`) and fail fast to the Tier-2 waterfall
  (`got-scraping` → FlareSolverr → Decodo → Wayback) instead of retrying a dead
  host and tripping the stall watchdog.
* **Leaner extraction:** `<script>`, `<style>`, `<noscript>`, `<svg>`, `<nav>`,
  `<footer>`, and `<header>` are removed from the DOM clone before
  Readability/Turndown, so navigation and markup never pollute the token budget.
* **Card provenance into the verifier:** every evidence card carries its resolved
  `sourceUrl` and `[n]` citation anchor, and the citation verifier registers both
  the canonical and resolved URL so provenance is never guessed.
* **Repo hygiene:** historical release notes moved to `CHANGELOG.md`, a clean
  scannable `README.md` with a zero-config vs optional-services table, and a
  `prebuild` version guard (`scripts/sync-version.mjs`) that keeps
  `package.json` `version` and `manifest.json` `revision` in sync.

## 🚀 What's New in v5.9.0?

* **Epistemic uncertainty mining (DeepThink):** the planner now runs reasoning-enabled, and a new pure, deterministic miner (`src/swarm/uncertainty-miner.ts`) reads its ` thinking` trace for the questions the model *itself* flagged — "unclear whether…", "no data on…", "conflicts with…", "need to verify…", "insufficient evidence", "cannot determine", "unresolved". The unresolved questions are converted into targeted search queries, deduped against everything already executed, and enqueued as one bounded extra search wave (≤3 queries) before the critic — so the swarm investigates exactly the gaps its own reasoning exposed, with zero extra LLM calls.
* **Cognitive scaffolding (`[THINKING PROTOCOL]`):** the planner and synthesis system prompts now carry a structured four-milestone reasoning rubric — **source credibility & recency audit → falsification & counter-claim checking → cross-domain corroboration verification → report structure outline** — turning free-form chain-of-thought into disciplined, verifiable deliberation whenever a phase runs with reasoning enabled.
* **Reasoning audit sidecar:** chain-of-thought is now captured *separately* from the answer (LM Studio reasoning fragments are split by `reasoningType`, with an inline `…` fallback) so it can never leak into the report narrative. The raw traces are preserved in a new machine-readable `IResearchRunRecord` (returned on `ResearchResult.metadata`), and — when the new **Include Reasoning Audit** setting is on (default) — appended to the report as a collapsible **`Swarm Reasoning & Verification Trace`** section showing the planner reasoning, the mined uncertainty queries, and the synthesis reasoning.
* **New setting:** *Include Reasoning Audit* (per-chat boolean, default **on**) toggles the collapsible reasoning/verification trace at the end of the report.

## 🚀 What's New in v5.8.2?

* **Qwen 3 reasoning hardening:** every LLM-completion JSON path now flows through a single `extractQwenJson` parser that strips `<think>…</think>` blocks (case-insensitive and nested-safe), removes Markdown code fences, and slices the outermost `{…}`/`[…]` payload before parsing — a chain-of-thought prefix can no longer break the planner, critic, or structured-output schemas.
* **Per-phase reasoning control:** new `reasoningEffort` / `disableThinking` options on the LLM layer tune thinking per phase. Repetitive tasks (critic, RAG gatekeeper, query mutation) run with thinking off (`enable_thinking:false` + a `/no_think` directive), the planner runs at `high`, synthesis at `medium`, and contradiction detection at `none`. Each call uses an isolated message array, so `<think>` context never leaks across worker turns.
* **Deterministic evidence pre-filter:** a new pure heuristic rejects unusable cards — text shorter than 180 chars, boilerplate/paywall signatures (“access denied”, “please enable javascript”, “sign in to continue”), and query-keyword overlap below 20% — *before* any LLM critic call, saving inference and keeping rejections deterministic and auditable.
* **Bounded evidence chunks:** evidence excerpts and claims are stripped of HTML artifacts and hard-capped at 6,000 characters everywhere they enter the LLM (critic batches, synthesis ledger), preventing KV-cache bloat from oversized pages.
* **RAG gatekeeper extracted & offline-safe:** the inline pre-flight gate now lives in `src/local/gatekeeper.ts`, runs with reasoning disabled, and preserves the original yes/no/error logging.

## 🚀 What's New in v5.8.0?

* **Structured plans & verdicts (JSON schema):** the AI planner now emits a first-class JSON plan — specialized workers, open questions, stopping conditions, an estimated remaining-time budget, an `index-only` citation policy, and domain tags — validated against a zod schema and requested through LM Studio's native structured output (`jsonSchema`), with the deterministic planner as the fallback. The critic grades the same way: JSON verdict batches (on-topic, dated, nature, contradicts, claim strength, pass) come back schema-validated, and any non-JSON output drops back to the strict `CARD:` line format.
* **Shared blackboard:** one coordination surface now carries the plan, the open gaps, the merged evidence cards, the critic-graded ledger, the blocked-list (URL + reason + hit count), and the live `time_left` budget. Workers and downstream readers all read from the same deterministic state — the orchestrator only assigns gaps and merges cards, it never writes report prose.
* **Independent citation verifier (pass^k-lite):** after synthesis, a deterministic checker re-reads the markdown and confirms every `[n]` citation resolves to a graded ledger card **and** every URL equals a card's canonical URL (normalized for www/trailing-slash/fragment/case). If it fails, synthesis is retried **once**; the report footer records `Citation pass: PASS/FAIL`, contradictions, retry used, and the applied skill pack either way — invented URLs cannot survive the report.
* **Deterministic guardrails:** new allow/deny domain lists (workers skip out-of-scope URLs and report them in `blocked_urls`), a per-PDF download byte cap, a per-run hard cap on `Use Plugin Tool` calls, a `Require Approval Before Writes` toggle that forces an explicit `confirmed: true` argument before any RAG write or external write-capable tool call, and prompt-injection scrubbing of extracted page text (directive-style lines, embedded base64/hex blobs) before it ever reaches the evidence/critic/synthesis pipeline.
* **Skill packs (AGENTS.md-style):** three bundled domain packs — **academic**, **policy**, **market** — are auto-selected from the planner's domain tags and injected into the critic + synthesis prompts. Users can override any pack or add their own under `~/.deep-swarm-research/skills/` (override wins); the active pack+version is logged and shown in the footer.
* **LLM concurrency control:** a global semaphore bounds parallel predictions (`llmConcurrency`, default 1 — one kv-cache slot), so the swarm's parallel crawling never fires more simultaneous predictions than LM Studio can safely multiplex.

## 🚀 What's New in v5.7.0?

* **Critic / verifier agent (evaluator–optimizer loop):** a dedicated, non-searching critic worker now grades every evidence card the crawl produces — on-topic fit, datedness, primary-vs-secondary, claim strength (`documented`/`disputed`/`anecdote`/`speculation`), and whether the card contradicts an already-accepted claim in the ledger. Grading is a deterministic pre-score followed by an LLM pass (≤6 cards/call, ≤4 batches, 0.1 temperature, 30s timeout) whose calls count against the run's LLM budget; if no model/budget/time remains it degrades silently to pure heuristics.
* **Targeted retry, not re-research:** only **failing** claims trigger one small second search round (≤3 queries, 4-page budget, follow-links disabled). Passing cards are never re-crawled, and newly added retry sources are graded incrementally against the already-accepted ledger.
* **Critic-graded synthesis:** the report builder now consumes a critic-verified ledger — only `PASS` cards feed the AI summarizer (prompt shows `CRITIC: …` verdicts) and critic-flagged disagreements become contradiction entries with severity derived from claim strength. When no model is loaded the run keeps the previous heuristic grading, so non-AI runs behave exactly as before.

## 🚀 What's New in v5.6.0?

* **Decodo Web Scraping API tier (server-side fetch):** a new optional fetch tier that resolves targets through Decodo's proxy pool (`scraper-api.decodo.com/v2/scrape`). This restores engines whose hosts are **TCP-blocked from the local network** (e.g. DuckDuckGo on this machine), without needing FlareSolverr's headless Chrome — which shares the same local egress and can't help there. Configure the token in plugin settings (`decodoApiToken`), via the `DECODO_API_TOKEN` environment variable, or in `~/.deep-swarm-research/api-keys.json`. When the direct tiers of any HTML engine fail (DDG, Bing, Brave, Google, Scholar, Mojeek, Yandex, SearXNG), the same search URL is fetched server-side and parsed as usual; the 200-call/run cap and auto-disable-after-5-failures keep it safe.
* **API engines now fail over to Decodo:** if the Serper or Brave API returns zero results, the query falls back to the engine's public HTML search page through the direct→Decodo→FlareSolverr tiers — so a dead API key or quota no longer silently starves a query.
* **DDG rate-limit hardening:** the DDG rate limiter now applies a **randomized jitter** (`minDelay × (1+rand)`) between queries instead of a fixed delay, and HTTP **202** responses (DDG's throttle signal) trigger a **shared exponential backoff** (8s → 16s → 32s → 64s → capped at 120s, ±15% jitter) honored by every lane, paginated page, and mutation query — the engine is never hammered again immediately. Baseline inter-query pacing was raised to ≥3s in every depth preset, and the health report tracks rate-limited (202) hits separately.
* **DDG HTML-first ordering:** `html.duckduckgo.com/html/` is now the primary tier (parsed directly from HTML — no JS/vqd flow), with the Lite POST endpoint as the fallback; Decodo/FlareSolverr fallbacks use the same HTML layout and parser.
* **Relevance gate fixed:** generic shared topic words ("evidence", "research", "analysis", …) no longer let off-topic pages (e.g. healthcare-real-world-evidence content) slip past the relevance filter. Topic keywords are now filtered against a generic-words list, and a page must match ≥60% of the remaining distinctive keywords to be admitted — fixing the "evidence about reincarnation" drift.
* **Better free-engine coverage:** the DIRECT search layer now fans out to every healthy free engine (bing, brave, google, scholar, mojeek, yandex, youtube, reference, gdelt) instead of a fixed pair, and workers lend Serper/Brave API an attempt whenever free results come in weak (<60% of the query target) — so queries that one engine under-delivers on still get filled.
* **FlareSolverr run-start probe:** the configured endpoint is connectivity-probed at run start (root, `/v1`, `/health` variants) and reported in the run health — no more silently skipping the bypass tier because the URL ended in `/v1`. Search-time FlareSolverr fallbacks were also wired into the Bing/Brave/Google/Scholar/Mojeek/Yandex/SearXNG HTML engines.
* **Fetch status surfaced:** `FetchResult` now carries the HTTP `statusCode` so downstream tiers can react to statuses like 202 instead of guessing from the body.

## 🚀 What's New in v5.5.1?

* **Fixed plugin load failure:** `got-scraping` v4 is ESM-only, but LM Studio bundles plugins as CommonJS and requires it externally, which crashed startup with `ERR_PACKAGE_PATH_NOT_EXPORTED`. The waterfall fetcher now loads it lazily via an indirect dynamic `import()`, so the plugin registers cleanly; if the module is ever unavailable the TLS tier is skipped and fetching falls through to FlareSolverr/Wayback. The Wayback tier now uses the built-in `fetch` instead of `got-scraping`.

## 🚀 What's New in v5.5.0?

* **Fixed page-cache persistence:** the visited-page cache no longer lives in a cwd-relative `.cache/` folder (which could be unwritable or reset depending on the working directory). It now lives under `~/.deep-swarm-research/cache/visited-pages-v2.json`, migrates any existing v1 cache once, writes atomically (temp file + rename), debounces saves, and caps itself at 2,000 entries (oldest evicted first). Post-redirect URLs are aliased back to the requested URL so lookups always hit.
* **Negative cache:** URLs that fail to fetch or are decisively off-topic/low-content are remembered for 24h (`isRejected`/`markRejected`) and skipped on subsequent runs, avoiding repeated dead-link retries. A successful fetch clears the negative entry.
* **PDF text extraction:** pages are now extracted from PDFs via `pdf-parse`, so long reports and papers feed real text into extraction instead of being skipped.
* **Real time-limit enforcement:** the session limit now drives a hard wall-clock abort timer (not just a soft crawl deadline), logs the *effective* runtime (`min(session limit, LLM mode cap)`), and shows requested-vs-effective in the run footer. `0` means **no session limit** for crawling while LLM calls stay bounded by the mode budget.
* **Feeds run automatically:** when `rssFeedUrls` / `telegramChannels` are configured, a dedicated feed pass queries them once per run (topic + top planned queries) instead of being limited to benchmark mode; the standalone `Search` tool also includes them by default.
* **Cache visibility:** run footer/logs now report visited + negative-cache entry counts, the cache file path, and negative-cache skips.

## 🚀 What's New in v5.4.0?

* **More results per query:** fixed the volume bug where `multiEngineSearch` divided the requested result count across engines, so 3 engines returned ~3 hits each instead of the full budget. Workers and the standalone `Search` tool now pass a per-engine target (`resultsPerQuery × engineCount`, capped at 20/engine), so every engine contributes its full share before merge/dedupe.
* **Deeper source extraction:** extraction previously stored only the first `contentLimit` characters of each page. Deep presets now stitch multiple chunks of the same document (`extractPagesPerSource`: 1/1/2/2/3 across shallow→exhaustive) into a single richer source, for long articles and multi-page PDFs.
* **Richer `Search` tool:** now queries DuckDuckGo + Bing + reference sites by default (plus OpenAlex/Crossref/arXiv when academic APIs are on, and YouTube when enabled), forwards API keys and recency, and accepts optional `engines` and `timeRange` parameters. Results are still scored/ranked by domain authority, URL quality, and freshness.
* **More detailed reports:** evidence excerpts are now configurable (`evidenceExcerptChars`, preset 300–1000) instead of a hardcoded 120/300-char slice, and the full-source appendix preview was raised from 700 → 1500 chars.
* **New config knobs:** Content Budget Mode (Auto scales per-page chars with depth, or Manual), Results Per Query override (0 = preset), Evidence Excerpt Per Source, and Adaptive Learning on/off.
* **Cross-plugin tools:** a new `Use Plugin Tool` tool lets the model list and invoke tools exposed by *other* loaded LM Studio plugins (`ctl.client.plugins.pluginTools`), so Deep Swarm can pull evidence/capabilities from companion plugins. Configure target plugin ids via the `externalPluginTools` setting; the remote session is always disposed.
* **Real adaptive learning (persistent):** the advertised `priority` engine-selection mode is now implemented, and outcome statistics persist across runs under `~/.deep-swarm-research/` — engine success EMAs now order engines in Priority mode, mutation strategies are ranked by historical acceptance, and domains get a small score adjustment based on accepted/rejected history (after ≥3 samples). When a model is loaded, a final reflection pass distills reusable search-strategy hints that future runs fold into query planning. All of it is heuristic/statistical — no model weights or plugin code are modified — and it can be disabled with the Adaptive Learning toggle.

## 🚀 What's New in v5.3.7?

* **New Bing engine:** keyless HTML scraping with `u=` base64 target decoding. Live-tested: 10/10 result blocks decode into real URLs with snippets. Bing now replaces Google-scrape/Mojeek/Yandex as the second keyless web engine everywhere (worker extra engines, gap fillers, standalone Search tool).
* **YouTube search fixed:** the `youtube` engine no longer scrapes the JS-rendered results page (which only yielded self-links). It now POSTs to `youtubei/v1/search` with the same WEB client the site uses, extracting real video results (title, owner, publish date, duration).
* **Per-engine health gating:** fragile no-key engines (bing, brave, google, scholar, searxng, mojeek, yandex, youtube) now get per-engine health tracking — 3 consecutive empty results trigger an 11-minute cooldown, so dead engines stop burning 4–5s queue slots on every query. Reliable API/reference engines run unconditionally.
* **Dead engines pruned:** removed the dead `search.ononoki.org` searxng endpoint and dropped Mojeek/Yandex/Google-scrape from default profile engine lists.
* **Mutation upgrades:** acceptance scoring is now relevance-aware (title/snippet/URL token overlap with the original query + host diversity, so off-topic mutations can't "win"); the LLM call budget is only charged when a model is actually loaded; accepted mutations are fed back through the extra engines; and mutation hits carry full route attribution.

## 🚀 What's New in v5.3.6?

* **Grokipedia search fixed:** was returning zero results — the plugin used the wrong query param (`?query=` vs the site's `?q=`) and the wrong link selector (`/wiki/` vs the site's actual `/page/<slug>` paths). It now canonicalizes `/page/` links, pulls real snippets, and is properly scored as a reference domain.
* **YouTube transcripts now actually fetch:** YouTube began returning empty caption bodies to anonymous requests, so transcript extraction silently degraded to video descriptions. The extractor now reads `ytInitialPlayerResponse`, extracts the INNERTUBE API key, and calls the `youtubei/v1/player` endpoint (ANDROID client) to obtain a working timedtext URL, with graceful fallback when YouTube requires a proof-of-origin token (`exp=xpe`).
* **YouTube engine reachable in adaptive mode:** `enableYouTube` previously only added the `youtube` engine in benchmark mode; it now also joins `breadth`/`academic` roles in adaptive runs, so transcript sources actually surface.

## 🚀 What's New in v5.3.5?

* **SSRF hardening:** a dedicated, unit-tested SSRF guard now blocks internal/private targets, IPv4-mapped forms, numeric-obfuscated addresses, special-use DNS suffixes (`.local`, `.internal`, `.home.arpa`), and DNS-rebinding attempts before any request is made.
* **Archive-on-failure:** when a page fails every fetch tier, the plugin submits it once per run to the Wayback Machine (`/save/`), writes a local log to `~/.deep-swarm-research/archives.json`, and reports archived pages in the run-health footer.
* **RSS & Telegram feeds:** optional `rssFeedUrls` and `telegramChannels` in `api-keys.json` let workers mine feeds and public channels as extra evidence sources.
* **Run-health footer:** every report now ends with a compact 🔍 Query Log / 🚦 Source Health / 🤖 LLM Watchdog / 💾 Cache & Archives summary (DDG state, LLM calls used, cache entries, archives submitted).
* **Cache duration in days:** the Cache Duration setting is now interpreted as days (default 30) instead of months.
* **Hardened archive fallback list:** dead or risky mirrors (Google webcache, corsproxy.io, allorigins, cors-anywhere, freezedry) were removed; only resilient maintained archives (Wayback Machine, archive.today) remain.
* **Tests & CI:** a Vitest suite (SSRF, URL normalization, archiver logic) plus a GitHub Actions workflow (typecheck, test, audit) keep regressions out.

## 🚀 What's New in v5.3.4?

* **Config fields now work:** Cache Duration, Context Budget Mode, Manual Context Limit, Max Synthesis Tokens, LLM Context Isolation, LLM Call Budget, FlareSolverr URL, and Crossref email all reach the live run.
* **Stall watchdog is live:** a 2-minute no-progress detector aborts workers and flushes partial results to synthesis instead of hanging forever.
* **Session time fixed:** `0` = no explicit cap; the effective crawl deadline is now `min(session, LLM watchdog runtime)` so the two settings stop overriding each other.
* **Waterfall fetcher wired in:** worker fetching now cascades standard fetch → got-scraping → FlareSolverr → Wayback Machine.
* **Query mutation via the SDK:** the hard-coded `localhost:1234` endpoint is gone; the loaded LM Studio model is used, on any port.
* **DDG health aligned:** 1 result is a success (matching the tripwire), so tight queries no longer fake-block DDG into 11-minute cooldowns.
* **Misc fixes:** `ReadSkillFile` tool registered, coverage-table ✓/— marks, duplicate-type cleanup, and a configurable Crossref User-Agent.

The **v5.3.3** release introduced an advanced cognitive and architectural overhaul focused on strict factuality, elimination of noise, and intelligent time budgeting.

**🔍 1. Relevance, Not "Coverage"**

* Replaced superficial keyword-hit dimension counters with strict semantic relevance pre-filters.
* Pages that share vocabulary but lack true subject alignment (e.g., SEO linkfarms, gaming streams, irrelevant LLM blog posts) are automatically rejected before entering synthesis.

**📋 2. Auditable Citations & Entity Hygiene**

* Every non-obvious claim requires a direct URL, title, and date mapping. Phantom references and un-crawled citations are completely banned.
* Structured entity extraction prevents snippet-merging glitches (such as misidentifying historical names and case studies).

**🏷️ 3. Claim Strength Guardrails**

* Enforces explicit epistemic tagging on every claim (*documented, disputed, anecdote, speculation*).
* Intensifiers (e.g., "most convincing," "extensively documented") are restricted unless backed by explicit data. A dedicated alternative-explanation worker actively hunts for contradictions and criticisms.

**⏱️ 4. Quality-Budgeted Time Management**

* The orchestrator reserves the final 20% of the session clock exclusively for verification, sorting, and synthesis.
* On session timeout, the system gracefully curates the top-N highest authority sources rather than dumping raw unverified text.

**🛡️ The Unbreakable Search Engine (Waterfall Fetcher)**

* **Tier A (got-scraping):** Native TLS fingerprinting bypasses 80% of passive Cloudflare blocks.


* **Tier B (FlareSolverr):** Optional advanced UI toggle to route aggressive JS challenges through a local headless browser.


* **Tier C (Wayback Machine):** If a website blocks the plugin with a 403 or Captcha, it automatically falls back to cache archives so research never stalls.


* **Tri-Mode Engine Routing:** Choose between Adaptive (fallback on failure), Benchmark (test all engines), or Priority (historical bests).



**🧠 Adaptive Context Budget & Watchdog**

* **No More Context Crashes:** Dynamically calculates safe token limits. It uses a strict Evidence Ledger (compact 120-token cards) instead of raw text, enforcing a hard 18,000-token synthesis ceiling.


* **LLM Call Budget & Stall Detection:** Hard caps on model calls (Standard = 45 calls) prevent infinite loops. A 2-minute stall watchdog safely cancels hung runs and outputs a partial report.



---

## 📦 Installation & Setup

**1. API Keys Setup (Optional but Recommended)**


The plugin works perfectly using free scraping (DDG/Brave/SearXNG), but you can optionally use premium APIs for fast, reliable gap-filling.
Run the plugin once to auto-generate the keys file at:

* **Windows:** `C:\Users\<you>\.deep-swarm-research\api-keys.json`

* **macOS/Linux:** `~/.deep-swarm-research/api-keys.json`


```json
{
  "serperApiKey": "YOUR_SERPER_KEY",
  "braveApiKey": "YOUR_BRAVE_KEY",
  "decodoApiToken": "YOUR_DECODO_TOKEN",
  "crossrefMailto": "you@example.com",
  "rssFeedUrls": ["https://feeds.bbci.co.uk/news/rss.xml"],
  "telegramChannels": ["channelname"]
}
```
The optional `crossrefMailto` is used in the Crossref API User-Agent header (required by Crossref for polite pool access).
The optional `rssFeedUrls` and `telegramChannels` enable RSS/Telegram mining as extra evidence sources during research.
`decodoApiToken` enables the **Decodo Web Scraping API** server-side fetch tier — the fix for networks that TCP-block search hosts (e.g. DuckDuckGo). Get a token from [dashboard.decodo.com](https://dashboard.decodo.com) → Web Scraping API → API Playground. It can also be set via `~/.deep-swarm-research/api-keys.json`, the `DECODO_API_TOKEN` environment variable, or the plugin-settings field (precedence: plugin field → env → `api-keys.json`).

**2. Local Document Sources (RAG)**


Want the swarm to research your proprietary files alongside the web? Use the `RAG Add Library` tool to index a local folder. In the LM Studio plugin settings, change Data Sources to `Local documents and web` (or Local only).

---

## 🛠️ Available Tools

**Research & Web**

* **DeepResearch:** The main tool. Give it a topic, get back a full Markdown report with AI analysis, citations, contradiction detection, and 12-dimension coverage.


* **Search:** Scored web results with domain authority tiers.


* **Read Page / Multi-Read:** Fetch and extract up to 10 URLs concurrently. Handles PDFs automatically.


* **ReadSkillFile:** Load a specialized formatting/domain skill file before synthesizing research.
* **Skill packs (auto-applied):** bundled **academic / policy / market** AGENTS.md-style packs are auto-selected from the topic's domain tags and applied to the critic + synthesis prompts. Override or extend them under `~/.deep-swarm-research/skills/` (override wins). Add your own pack by dropping a Markdown file with frontmatter (`name`, `version`, `domains`) into that folder.



**Local Library & RAG**

* **RAG Add / List / Remove:** Manage indexed local folders with priority tiers (proprietary, internal, reference, general).


* **RAG Search:** Search libraries using BM25 + fuzzy n-gram hybrid scoring.


* **RAG Check Changes:** Detect modified, deleted, or new files.


* **RAG Save / Load Index:** Persist the index to disk for instant access next session.

  > When **Require Approval Before Writes** is On, the write tools (`RAG Add/Update/Remove/Save/Load`) and write-capable external plugin tools only run when the caller passes `confirmed: true` — treat it as an explicit "yes, I the user approve this change".



---

## 🧠 How It Works (The Fail-Safe Agentic Loop)



* **Decomposition:** Breaks the topic into up to 10 specialized worker roles (academic, regulatory, statistical, etc.).


* **Mandatory Local Layer:** The swarm ALWAYS searches local RAG libraries first. If local evidence is sufficient, it skips the web entirely.


* **Gap-Driven Web Search:** External searches are driven strictly by missing dimensions (gaps). Free engines are used first; paid APIs are held in reserve.


* **Anti-Block Fetching:** Pages are fetched using the new Waterfall Strategy. If blocked, it seamlessly falls back to FlareSolverr or web archives.


* **Evidence Ledger:** Workers extract compact "Evidence Cards" sorted into 4 Verification Tiers.


* **Watchdog:** A strict call budget and stall detector prevent infinite loops.


* **Synthesis:** The LLM writes a narrative report in an isolated context, guaranteeing no overflow.



### Progressive Source Approach

For organizations with large datalakes, the plugin searches in priority order:

```text
┌─────────────────────┐
│  1. PROPRIETARY      │  < Confidential data (contracts, internal memos)
│     Searched first   │
├─────────────────────┤
│  2. INTERNAL         │  < Shared team knowledge (wikis, documentation)
│     Searched second  │
├─────────────────────┤
│  3. REFERENCE        │  < Curated reference materials (papers, standards)
│     Searched third   │
├─────────────────────┤
│  4. GENERAL          │  < Miscellaneous local documents
│     Searched fourth  │
├─────────────────────┤
│  5. WEB              │  < Public internet (fills remaining gaps)
│     Searched last    │
└─────────────────────┘

```

---

## 📊 Depth Presets

|  | Shallow | Standard | Deep | Deeper | Exhaustive |
| --- | --- | --- | --- | --- | --- |
| **Rounds**<br> | 1

 | 3

 | 5

 | 10

 | 15

 |
| **Worker roles**<br> | 5

 | 5

 | 8

 | 10

 | 10

 |
| **Pages/worker**<br> | 5

 | 8

 | 12

 | 18

 | 25

 |
| **Search engines**<br> | 1

 | 2

 | 3

 | 4

 | 5

 |
| **Link depth**<br> | 1

 | 1

 | 2

 | 2

 | 3

 |
| **Content/page**<br> | 5K

 | 6K

 | 8K

 | 12K

 | 16K

 |
| **Max Sources**<br> | ~50

 | ~80

 | ~150

 | ~250+

 | ~400+

 |

---

## ⚙️ Configuration (LM Studio UI)



| Setting | Description |
| --- | --- |
| **Data Sources**<br> | Web only, Local documents only, or Local documents and web.

 |
| **Research Depth**<br> | Shallow -> Exhaustive. Controls rounds and budgets.

 |
| **Engine Selection Mode**<br> | Adaptive, Benchmark, or Priority.

 |
| **Context Budget Mode**<br> | Auto (Recommended). Dynamically scales token limits.

 |
| **LLM Call Budget**<br> | Standard (Max 45 calls). Prevents infinite loops.

 |
| **LLM Context Isolation**<br> | Strict isolation. Prevents history bleed.

 |
| **Max Session Time**<br> | Hard cap on wall-clock time (minutes; automatically reserves 20% for final synthesis). Set to **0** for no explicit cap (still bounded by the LLM call watchdog runtime).

 |
| **Academic APIs**<br> | Query OpenAlex, Crossref, and arXiv directly for papers.

 |
| **YouTube Search**<br> | Enable YouTube scraping and transcript extraction.

 |
| **Cache Duration**<br> | Days to reuse previously visited pages (default 30). 0 disables caching. |
| **FlareSolverr URL**<br> | Advanced: Local endpoint for Cloudflare bypass (e.g., `[http://127.0.0.1:8191/v1](http://127.0.0.1:8191/v1)`).
  |
| **Decodo Web Scraping API Token**<br> | Advanced: Server-side fetch tier for engines TCP-blocked from your network (e.g. DDG). Get a token at `dashboard.decodo.com`. Leave blank to disable.
  |
| **Allowed Domains**<br> | Advanced: comma-separated allow-list of root domains. When set, workers only crawl/search hosts on this domain (or subdomains, e.g. `arxiv.org`). Leave blank to allow all.
  |
| **Blocked Domains**<br> | Advanced: comma-separated deny-list of root domains. URLs on these hosts are skipped and reported in the run's `blocked_urls`. Blocked wins over Allowed.
  |
| **Max PDF Download Size**<br> | Advanced: hard byte cap per PDF before extraction (`0` = no cap) so a single giant document can't eat the crawl budget.
  |
| **Max External Plugin Tool Calls**<br> | Advanced: per-run cap on `Use Plugin Tool` invocations (`0` = unlimited).
  |
| **Require Approval Before Writes**<br> | When On, RAG write tools (Add/Update/Remove/Save/Load) and write-capable external plugin tools require an explicit `confirmed: true` argument, so the model can't silently modify your index or call write-capable tools.
  |
| **Concurrent LLM Calls**<br> | Parallel predictions allowed through the global semaphore (default `1`, LM Studio typically serves one kv-cache slot). Crawling stays parallel regardless.
  |

---

## 📜 Changelog

* **v5.9.1** - Local-model hardening: flat, prose-free critic wire schema (primitives/booleans/enums only) reconstructed deterministically into `CriticVerdict`; tiered lexical gate (`lexicalScore`) grades strongest cards first and only retries parse failures on top-tier evidence; `<think>` parser strips truncated/unclosed blocks; uncertainty mining gated by wall-clock (>65%) and LLM budget (`activeWorkers + 3`) with Jaccard (≥0.75) query dedupe; strict 4,500 ms Tier-1 fetch timeout with fast failover to the waterfall; pre-Readability removal of script/style/noscript/svg/nav/footer/header nodes; resolved `sourceUrl` + `[n]` anchor carried into the citation verifier; README/CHANGELOG split and a `prebuild` version↔revision sync guard.
* **v5.9.0** - DeepThink reasoning architecture: epistemic uncertainty mining (`src/swarm/uncertainty-miner.ts` parses the planner's ` thinking` trace for self-flagged gaps — unclear/no-data/conflicts/needs-verification — and enqueues bounded targeted queries as an extra search wave); cognitive scaffolding (`[THINKING_PROTOCOL]` four-milestone rubric in the planner + synthesis system prompts); reasoning audit sidecar (chain-of-thought split from the answer via LM Studio reasoning fragments/inline fallback, stored on a new `IResearchRunRecord` and appended as a collapsible "Swarm Reasoning & Verification Trace" section behind the new `includeReasoningAudit` setting, default on).
* **v5.8.2** - Qwen 3 reasoning hardening: `<think>`-aware `extractQwenJson` parser routed through all LLM JSON paths; per-phase reasoning control (`reasoningEffort` / `disableThinking`, `/no_think` + `enable_thinking:false`) for planner/critic/synthesis/gatekeeper/query-mutation with isolated message arrays; deterministic heuristic evidence pre-filter (min length, boilerplate/paywall, <20% query overlap) before any critic LLM call; 6,000-char evidence-chunk cap with HTML stripping; RAG gatekeeper extracted to `src/local/gatekeeper.ts`.
* **v5.8.1** - Compact settings UI; Safe Search hidden, default off.
* **v5.8.0** - Structured plans & verdicts: the AI planner now outputs a validated JSON plan (workers, open questions, stop conditions, estimated time, `index-only` citation policy, domain tags) via LM Studio structured output with a deterministic fallback, and the critic parses JSON verdict batches the same way. Shared blackboard makes the plan, open gaps, merged evidence cards, graded ledger, blocked URLs, and the live time budget visible to all workers. pass^k-lite: an independent citation verifier checks every `[n]` and URL against the ledger, one synthesis retry is allowed on failure, and the footer records citation pass / contradictions / retry / skill pack. Deterministic guardrails: domain allow/deny lists, per-PDF byte cap, per-run external-tool call budget, a `confirmed:true` human-approval gate before any RAG write or external tool call, and prompt-injection scrubbing of extracted page text. Skill packs ship as AGENTS.md-style packs (academic / policy / market) auto-selected from the planner's domain tags, with per-user overrides under `~/.deep-swarm-research/skills/`.
* **v5.7.0** - Critic/verifier agent (evaluator-optimizer loop): dedicated non-searching critic grades every evidence card (on-topic, dated, primary/secondary, claim strength, contradicts ledger) via deterministic pre-score + budgeted LLM pass with heuristic fallback; only failing claims trigger one targeted ≤3-query retry round, incrementally re-graded against the accepted ledger; synthesis reads a critic-verified ledger (PASS cards only) and surfaces critic-flagged disagreements as severity-ranked contradiction entries.
* **v5.6.0** - Decodo Web Scraping API server-side fetch tier (restores DDG on TCP-blocked networks; applied everywhere an HTML engine or the Serper/Brave APIs come up empty), DDG rate-limit hardening (randomized inter-query jitter, exponential backoff + jitter on HTTP 202, html.duckduckgo.com/html/ primary, ≥3s baseline pacing in every preset), relevance-gate fix (generic shared topic words filtered; ≥60% distinctive-keyword match required), free-engine fan-out in the DIRECT layer with API lending when results are weak, FlareSolverr run-start probe + search-fallback wiring across all HTML engines, and HTTP status surfaced on fetch results.
* **v5.3.5** - SSRF guard hardened & unit-tested (internal/private IPs, DNS-rebinding, obfuscated addresses, `.local`/`.home.arpa`), archive-on-failure to the Wayback Machine with a local log, RSS & Telegram feed mining, run-health footer on every report, cache duration in days, archive fallback list pruned to resilient mirrors only, and a Vitest suite + GitHub Actions CI.
* **v5.3.4** - Config wiring fix (Cache Duration, Context Budget, Isolation, LLM Call Budget, FlareSolverr, Crossref email now reach the run), active 2-minute stall watchdog with partial-result flush, session-time/LLM-budget cap alignment (`0 = unlimited`), DDG health threshold aligned to the 1-result tripwire, Waterfall fetcher wired into the live fetch path (got-scraping/FlareSolverr/Wayback), SDK-based query mutation (no hard-coded port), configurable Crossref User-Agent, ReadSkillFile tool registered, coverage-table marks, and duplicate-interface cleanup.
* **v5.3.3** - Entity-first query planning, strict relevance pre-filtering, time-budget synthesis reservation, and claim strength verification.
* **v5.3.2** - Multi-tier waterfall fetcher, FlareSolverr Cloudflare bypass, DOM parser crash fix, and AI query planner overhaul.


* **v5.3.1** - Enterprise-grade fail-safe architecture, Watchdog, Context Budget, and Verification Tiers.


* **v5.2.1** - Multi-API, Tri-Mode Engines (Adaptive/Benchmark/Priority), & YouTube transcripts.


* **v5.2.0** - AI-Driven Query Mutation & Anti-Block Upgrades.


* **v5.1** - Native Engine Time Filtering & Architecture.


* **v5.0** - Failure Memory & State Tracking.


* **v4.0** - Session Timeouts.


* **v3.0 & v1.0** - Initial Swarm & Wall-Clock Limits.

