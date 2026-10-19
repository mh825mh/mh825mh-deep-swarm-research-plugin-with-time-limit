# 🐝 Deep Research w/ Swarm Agent

Autonomous deep research for **LM Studio**. A swarm of specialized AI workers
searches your local documents and the web, adapts its strategy, verifies claims,
and synthesizes everything into a structured, confidence-scored report with
auditable citations — all in one tool call.

- Version: **5.10.0**
- Runtime: local-first (no cloud required)
- History: see [`CHANGELOG.md`](./CHANGELOG.md)

> **New in 5.10.0:** a Qwen 3.8 fast-call mode (empty `<think>` prefill +
> `/no_think`) so the gatekeeper, critic, and query mutator never stall inside a
> reasoning block; a Tier-0 keyless JSON pre-seeder (OpenAlex + Wikipedia REST)
> that lands verified citations in <3.5s before any HTML engine; intra-page BM25
> windowing so the critic and synthesis read the most relevant paragraphs instead
> of the page top; a topic-adaptive fallback planner; a KV-cache-pinned system
> prefix shared across planner → critic → synthesis; in-run singleflight URL
> dedupe; a pre-fetch SERP snippet gate; and a skill-pack fallback that ends
> `[SKILL] none`.

## ⚡ Quick start

1. Install the plugin in LM Studio (Node runtime).
2. Load a model and ask for research, comparison, or analysis.
3. The model calls the **DeepResearch** tool and returns a cited Markdown report.

No API keys, proxies, or extra services are required. Everything below is
optional.

## 🆓 Zero-config local mode vs optional external services

The plugin is fully functional with free scraping only. External services are
opt-in and only ever *add* reliability — when a key is missing, every engine
falls back to free scraping automatically.

| Capability | Zero-config local mode | Optional external service |
| --- | --- | --- |
| Web search | DuckDuckGo + Bing + Brave (HTML), reference sites | **Serper** / **Brave API** keys for fast, quota-backed results |
| Page fetching | Direct HTTP → `got-scraping` TLS → Wayback Machine | **FlareSolverr** (local headless Chrome) for aggressive JS challenges |
| Blocked egress (e.g. DDG TCP-blocked on your network) | Falls through to other free engines + Wayback | **Decodo Web Scraping API** fetches server-side through its proxy pool |
| Local RAG | Built-in BM25 + n-gram index | — |
| Academic APIs | OpenAlex / Crossref / arXiv (keyless) | Crossref polite-pool `crossrefMailto` |
| Feeds | — | `rssFeedUrls`, `telegramChannels` |
| Model | Any local LM Studio model | — |

**Precedence for secrets:** plugin settings field → environment variable
(`DECODO_API_TOKEN`) → `~/.deep-swarm-research/api-keys.json`.

```jsonc
// ~/.deep-swarm-research/api-keys.json  (Windows: C:\Users\<you>\.deep-swarm-research\)
{
  "serperApiKey": "YOUR_SERPER_KEY",        // optional
  "braveApiKey": "YOUR_BRAVE_KEY",          // optional
  "decodoApiToken": "YOUR_DECODO_TOKEN",    // optional
  "crossrefMailto": "you@example.com",      // optional
  "rssFeedUrls": ["https://feeds.bbci.co.uk/news/rss.xml"],
  "telegramChannels": ["channelname"]
}
```

Run the plugin once to auto-generate the file location.

## 🛠️ Available tools

**Research & web**

| Tool | Purpose |
| --- | --- |
| **DeepResearch** | Main entry — full Markdown report with citations, contradictions, and dimension coverage. |
| **Search** | Scored web results with domain-authority tiers. |
| **Read Page / Multi-Read** | Fetch + extract up to 10 URLs concurrently (PDFs handled automatically). |
| **PDF Batch Read** | Batch PDF text extraction. |
| **ReadSkillFile** | Load a domain/formatting skill file before synthesizing. |
| **Use Plugin Tool** | Invoke tools from other loaded LM Studio plugins (budget-capped). |

**Local library (RAG)**

| Tool | Purpose |
| --- | --- |
| **RAG Add / List / Remove / Update Library** | Manage indexed folders with priority tiers. |
| **RAG Search** | BM25 + fuzzy n-gram hybrid search. |
| **RAG Check Changes** | Detect modified, deleted, or new files. |
| **RAG Save / Load Index** | Persist the index to disk. |

> With **Require Approval Before Writes** on, write tools only run when the
> caller passes `confirmed: true`.

## 🧠 How it works

1. **Plan** — the topic is decomposed into up to 10 specialized worker roles,
   emitted as a validated JSON plan (with a deterministic, topic-adaptive
   fallback).
2. **Local first** — local RAG libraries are always searched before the web;
   if local evidence is sufficient, the web layer is skipped.
3. **Tier-0 JSON pre-seed** — keyless OpenAlex + Wikipedia REST feeds verified
   reference cards into the ledger in under ~3.5s, *before* any HTML engine can
   be rate-limited, so a run never ends with zero citations.
4. **Gap-driven web search** — queries target missing dimensions. Free engines
   run first; paid APIs are held in reserve.
5. **Anti-block fetching** — a waterfall cascades direct fetch → `got-scraping`
   → FlareSolverr → Wayback Machine (plus Decodo when configured). A pre-fetch
   snippet gate drops junk/login-wall URLs and in-run singleflight collapses
   concurrent duplicate URL fetches.
6. **Critic / verifier** — every evidence card is graded (deterministic
   pre-score + batched LLM pass); only failing claims trigger one bounded retry.
   Pages are BM25-windowed first, so only the most relevant paragraphs are
   graded.
7. **Synthesize & verify** — an isolated synthesis pass writes the report, then
   an independent verifier confirms every `[n]` citation and URL resolves to the
   ledger.

### Progressive source approach

```
1. PROPRIETARY   local, confidential (contracts, internal memos)
2. INTERNAL      shared team knowledge (wikis, docs)
3. REFERENCE     curated reference material (papers, standards)
4. GENERAL       miscellaneous local documents
5. WEB           public internet (fills remaining gaps)
```

## 📊 Depth presets

| | Shallow | Standard | Deep | Deeper | Exhaustive |
| --- | --- | --- | --- | --- | --- |
| Rounds | 1 | 3 | 5 | 10 | 15 |
| Worker roles | 5 | 5 | 8 | 10 | 10 |
| Pages/worker | 5 | 8 | 12 | 18 | 25 |
| Search engines | 1 | 2 | 3 | 4 | 5 |
| Link depth | 1 | 1 | 2 | 2 | 3 |
| Content/page | 5K | 6K | 8K | 12K | 16K |
| Max sources | ~50 | ~80 | ~150 | ~250+ | ~400+ |

## ⚙️ Configuration

| Setting | Description |
| --- | --- |
| **Data Sources** | Web only, Local documents only, or Local documents and web. |
| **Research Depth** | Shallow → Exhaustive. Controls rounds and budgets. |
| **Engine Selection Mode** | Adaptive, Benchmark, or Priority. |
| **Context Budget Mode** | Auto (recommended) scales token limits dynamically. |
| **LLM Call Budget** | Standard = max 45 calls; prevents infinite loops. |
| **LLM Context Isolation** | Strict isolation; prevents history bleed. |
| **Max Session Time** | Hard wall-clock cap (minutes, 20% reserved for synthesis). `0` = no explicit cap. |
| **Academic APIs** | Query OpenAlex, Crossref, and arXiv directly. |
| **YouTube Search** | Enable YouTube scraping and transcript extraction. |
| **Cache Duration** | Days to reuse visited pages (default 30). `0` disables caching. |
| **FlareSolverr URL** | *Optional:* local Cloudflare bypass endpoint. |
| **Decodo Web Scraping API Token** | *Optional:* server-side fetch for TCP-blocked hosts. |
| **Allowed / Blocked Domains** | Comma-separated root-domain allow/deny lists (deny wins). |
| **Max PDF Download Size** | Hard byte cap per PDF (`0` = no cap). |
| **Max External Plugin Tool Calls** | Per-run cap on `Use Plugin Tool` (`0` = unlimited). |
| **Require Approval Before Writes** | Requires `confirmed: true` for RAG writes / write-capable tools. |
| **Concurrent LLM Calls** | Parallel predictions through the global semaphore (default `1`). |
| **Include Reasoning Audit** | Append the collapsible reasoning/verification trace to the report. |

## 🗣️ Recommended system prompts

<details>
<summary>14B+ models</summary>

```text
You are an expert Deep Research Analyst. Your goal is to synthesize complex information from local proprietary databases and the public web into highly structured, objective, and rigorously cited reports.

TOOL INVOCATION RULES
When a user asks for research, analysis, comparisons, or deep dives, you MUST use the "DeepResearch" tool.
- Use focusAreas to break down complex prompts into specific angles.
- Use depthOverride to control the breadth of the research.

POST-RESEARCH SYNTHESIS FRAMEWORK
When the tool returns the research report, structure your response exactly as follows:
1. Executive Summary: A concise, 3-4 sentence TL;DR.
2. Core Analysis: Detailed synthesis organized by theme, NOT by source.
3. Source Origin & Temporal Context: Note if findings rely on Local vs. Web data, and the time period.
4. Contradictions & Nuance: Highlight conflicting sources objectively.
5. Coverage Gaps & Next Steps: Identify missing info and suggest follow-ups.

STRICT CITATION & CONFIDENCE RULES
- You MUST cite every factual claim using the exact index format provided by the tool: [1], [2], etc.
- NEVER invent, guess, or hallucinate citation numbers.
- If the tool provides [High/Medium/Low Confidence] tags, preserve them.
- Prioritize proprietary/internal sources over web sources when they conflict.

TONE & STYLE
- Maintain a highly professional, objective, and analytical tone.
- Avoid filler phrases like "Based on the research provided..." Just deliver the analysis directly.
- Use Markdown formatting (bolding, lists, tables) to make dense information highly readable.
```

</details>

<details>
<summary>7B–8B models (compact)</summary>

```text
You are an expert Research Analyst. Use the "Deep Research" tool for any complex query, setting `depthOverride` based on complexity.

When the tool returns results, format your response exactly like this:
1. **Executive Summary**: 3-sentence TL;DR.
2. **Detailed Analysis**: Synthesize by theme, not by source.
3. **Source Context**: Note if findings rely on Local/Proprietary docs vs Web, and note the time period.
4. **Contradictions**: Highlight conflicting sources objectively.
5. **Gaps**: What is missing? Suggest follow-ups.

STRICT RULES:
- Cite EVERY claim using the tool's exact numbers: [1], [2], etc. NEVER hallucinate citation numbers.
- Prioritize Local/Proprietary sources over Web sources.
- Do not use filler phrases. Be direct, objective, and use Markdown tables/lists for readability.
```

</details>

## 📄 License

MIT License
