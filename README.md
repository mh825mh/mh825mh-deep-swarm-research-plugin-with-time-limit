# 🐝 Deep Research w/ Swarm Agent

Autonomous deep research for **LM Studio**. A swarm of specialized AI workers
searches your local documents and the web, adapts its strategy, verifies claims,
and synthesizes everything into a structured, confidence-scored report with
auditable citations — all in one tool call.

[![Version](https://img.shields.io/badge/version-5.12.0-blue)]()
[![License](https://img.shields.io/badge/license-MIT-green)]()
[![Node](https://img.shields.io/badge/runtime-Node.js-orange)]()
[![Platform](https://img.shields.io/badge/platform-LM Studio-blue)]()

- Version: **5.12.0**
- Runtime: local-first (no cloud required)
- History: see [`CHANGELOG.md`](./CHANGELOG.md)

**Quick links:**
- [Quick start](#-quick-start)
- [Examples](#-examples)
- [Configuration](#-configuration)
- [Troubleshooting](#-troubleshooting)
- [System Requirements](#-system-requirements)

> **Qwen 3.8 fast-call mode:** Optimized for Qwen-class models, this mode pre-fills an empty reasoning block and appends `/no_think` to prevent truncation of short verdicts, enabling faster reasoning calls without losing detailed traces.

> **New in 5.12.0:** a reliability-focused release for long local runs.
>
> - **AI workers are respected:** standard depth now caps the plan at 5 active
>   workers x 2 queries, uses the AI-decomposed workers instead of expanding
>   into hardcoded SaaS/product roles, and strips commercial boilerplate from
>   non-commercial topics.
> - **Local SearXNG is faster and safer:** JSON-first parsing (`format=json`),
>   a 12s per-query timeout, max 2 concurrent local requests, and no 10-minute
>   cooldown when a query legitimately returns 0 results.
> - **Layers stop when the job is done:** after SearXNG, the swarm exits the
>   layer loop once it has 12 web sources or 75% of workers have >=2 sources;
>   workers already at 50% of their budget are not re-run in DIRECT/API.
> - **Source diversity:** max 2 pages per host per worker and 3 per host across
>   the run (Wikipedia/OpenAlex exempt), standard-depth link following is capped
>   at depth 1 and only runs below 4 direct sources.
> - **Realistic relevance:** `rel` scores now combine core-term overlap (0.6)
>   with query/dimension overlap (0.4) and cap at 0.92 instead of clamping to
>   1.00.
> - **Fetch and Feeds guards:** FlareSolverr is skipped for `web.archive.org`,
>   `archive.org`, `sciencedirect.com`, and `researchgate.net`; Sciencedirect /
>   ResearchGate fail fast. The Feeds pass is skipped immediately when no real
>   RSS/Telegram targets are configured.
> - **Critic retry hygiene:** failed-card metadata (`[OpenAlex ...]`, `Title:`,
>   `Abstract:`) is stripped and retry queries are capped at 10 keywords.
> - **Plugin-safe LLM client:** reuses the authenticated controller client
>   instead of constructing `new LMStudioClient()` inside the plugin context.
>
> **New in 5.11.0:** the SearXNG engine now defaults to a **local instance**
> (`http://127.0.0.1:8080`, configurable via the `SearXNG URL` setting). The
> endpoint is probed at run start — if your local SearXNG is unreachable the run
> logs a single warning and transparently falls back to the public
> `https://searx.be`, so the engine works with zero configuration either way.

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

**What to expect:**
- Research happens entirely on your local machine
- Shallow depth typically completes in 30-60 seconds
- Standard/Deep depth may take 2-10 minutes depending on network and document count
- 14B+ models are recommended for optimal performance
- No API keys, proxies, or extra services are required. Everything below is
optional.

## 💡 Examples

### Research a topic with local documents
```
"Research the latest developments in quantum computing, focusing on recent papers in my local research folder"
```

### Compare multiple approaches
```
"Compare the performance of React vs Vue for enterprise applications, citing 3-5 sources each"
```

### Deep dive into a specific topic
```
"Analyze the impact of AI on software development, including both positive and negative aspects"
```

### Research with specific depth
```
"Explain how neural networks work, using shallow depth for a quick overview"
```

## 🆓 Zero-config local mode vs optional external services

The plugin is fully functional with free scraping only. External services are
opt-in and only ever *add* reliability — when a key is missing, every engine
falls back to free scraping automatically.

| Capability | Zero-config local mode | Optional external service |
| --- | --- | --- |
| Web search | DuckDuckGo + Bing + Brave + SearXNG (HTML scraping — SearXNG prefers your **local instance**, public `searx.be` as fallback), trusted reference sources | **Serper** / **Brave API** keys for fast, quota-backed results |
| Page fetching | Direct HTTP → `got-scraping` TLS → Wayback Machine (for inaccessible pages) | **FlareSolverr** (local headless Chrome) for aggressive JS challenges |
| Network restrictions | Falls through to other free engines + Wayback Machine | **Decodo Web Scraping API** fetches server-side through its proxy pool for TCP-blocked hosts |
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
| **ReadSkillFile** | Load domain/formatting skills before synthesis to improve report structure |
| **Use Plugin Tool** | Invoke other LM Studio plugins (e.g., budget tools) with per-run budget caps |

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

```
┌─────────────────────────────────────────────────────────────┐
│                     Research Topic                          │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  1. PLAN: Decompose into specialized worker roles           │
│     ┌─────────────┐ ┌─────────────┐ ┌─────────────┐         │
│     │  Scholar    │ │  Analyst    │ │  Critic     │         │
│     └─────────────┘ └─────────────┘ └─────────────┘         │
└────────────────────┬────────────────────────────────────────┘
                     │
        ┌────────────┴────────────┐
        ▼                         ▼
┌───────────────┐         ┌───────────────┐
│ Local RAG     │         │  Web Search   │
│ (documents)   │         │ (DuckDuckGo,  │
│               │         │  Bing, Brave) │
└───────┬───────┘         └───────┬───────┘
        │                         │
        └────────────┬────────────┘
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  2. COLLECT: Gather evidence with citation tracking         │
└────────────────────┬────────────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  3. VERIFY: Critic grades claims, retries failures          │
└────────────────────┬────────────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  4. SYNTHESIZE: Combine evidence into structured report     │
└────────────────────┬────────────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  5. VERIFY FINAL: Independent check of all citations        │
└─────────────────────────────────────────────────────────────┘
```


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

    **Key features explained:**
    - **Tier-0 JSON pre-seed:** Loads verified reference cards from OpenAlex and Wikipedia REST APIs before any HTML engine, ensuring zero-source runs never end with no citations
    - **KV-cache-pinned system prefix:** Ensures planner, critic, and synthesis share identical system messages for consistent behavior
    - **Intra-page BM25 windowing:** Extracts the most relevant paragraphs based on BM25 scoring instead of just reading order, so mid-article data reaches the critic

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
| **Max Session Time** | Hard wall-clock cap (minutes, 20% reserved for synthesis). `0` = no explicit cap (uses global timeout). |
| **Academic APIs** | Query OpenAlex, Crossref, and arXiv directly. |
| **YouTube Search** | Enable YouTube scraping and transcript extraction. |
| **Cache Duration** | Days to reuse visited pages (default 30). `0` disables caching. |
| **FlareSolverr URL** | *Optional:* local Cloudflare bypass endpoint. |
| **SearXNG URL** | *Optional:* local SearXNG instance (default `http://127.0.0.1:8080`). Probed at run start; if unreachable a warning is logged once and the engine falls back to the public `https://searx.be`. Blank = public only. |
| **Decodo Web Scraping API Token** | *Optional:* server-side fetch for TCP-blocked hosts. |
| **Allowed / Blocked Domains** | Comma-separated root-domain allow/deny lists (deny wins). |
| **Max PDF Download Size** | Hard byte cap per PDF (`0` = no cap, may use more disk space). |
| **Max External Plugin Tool Calls** | Per-run cap on `Use Plugin Tool` (`0` = unlimited). |
| **Require Approval Before Writes** | Requires `confirmed: true` for RAG writes / write-capable tools. |
| **Concurrent LLM Calls** | Parallel predictions through the global semaphore (default `1` to prevent model overload). |
| **Include Reasoning Trace** | Append the collapsible reasoning/verification trace to the report. |

## 🐛 Troubleshooting

### Research takes too long
- **Shallow depth:** Should complete in 30-60 seconds
- **Standard/Deep:** May take 2-10 minutes depending on network and document count
- **Check model size:** 14B+ models recommended for optimal performance
- **Verify network:** Ensure LM Studio has internet access for web search

### No citations found
- **Local-only mode:** If you selected "Local documents only," web sources won't be used
- **Check RAG index:** Ensure you've added documents to the local library
- **Try different depth:** Shallow depth may not find enough sources

### Model outputs truncated or cut off
- **Model too small:** 7B-8B models may struggle with complex reasoning
- **Increase context window:** Some models have output token limits
- **Try shallow depth:** Reduces reasoning complexity

### Network blocked / DDG not working
- **Use other engines:** DuckDuckGo, Bing, and Brave are used in fallback order
- **Configure Decodo:** Add Decodo API token for TCP-blocked hosts
- **Use Wayback Machine:** Pages are automatically fetched via Wayback if direct access fails

### PDFs not loading
- **Check file size:** Max PDF size is configurable (default: no limit)
- **Verify permissions:** Ensure LM Studio has read access to PDF files
- **Try smaller PDFs:** Large PDFs may take longer to process

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

## 💻 System Requirements

### Minimum
- **Model:** 7B+ parameter model (Qwen, Llama, Mistral, etc.)
- **RAM:** 8GB system RAM
- **Storage:** 500MB for plugin + RAG index
- **Network:** For web search (optional, local-only mode available)

### Recommended
- **Model:** 14B+ parameter model
- **RAM:** 16GB+ system RAM
- **Storage:** 1GB+ for RAG index with many documents
- **Network:** Stable internet connection for web search

### Local RAG Performance
- **BM25 index:** Fast (sub-second for small libraries)
- **Memory usage:** ~1-2GB per 10,000 documents
- **Indexing time:** ~1-2 seconds per 1,000 documents

## ⚠️ Limitations

- **Model size:** 7B-8B models may struggle with complex multi-step reasoning
- **RAG index size:** Very large libraries (100K+ docs) may slow down indexing
- **Web search:** Some websites block scraping, but fallback mechanisms exist
- **PDF processing:** Large PDFs (>50MB) may take significant time to process
- **Network dependency:** Web search requires internet access (local-only mode available)
- **Token limits:** Very deep research may hit model output token limits

## ❓ Frequently Asked Questions

**Q: Can I use this without internet?**
A: Yes! Use "Local documents only" mode for fully offline research.

**Q: How does the citation system work?**
A: Every claim is linked to a specific source from the evidence ledger, with confidence scores.

**Q: What's the difference between Shallow and Exhaustive depth?**
A: Shallow does 1 round with 5 sources; Exhaustive does 15 rounds with 25 sources per worker.

**Q: Can I use multiple models?**
A: Currently, the plugin works with any LM Studio model you load. Different models can be used for different research tasks.

**Q: How do I export the report?**
A: The report is generated in Markdown format. Copy-paste it into your favorite Markdown editor or convert to PDF.

**Q: Does it support real-time research?**
A: No, the plugin is designed for batch research. Submit your query and wait for the complete report.

## 🐛 Known Issues

- **Issue:** Some websites with aggressive anti-bot measures may still block access
  **Workaround:** Use Decodo API token or increase link depth to find alternative sources

- **Issue:** Very large RAG indexes (>50K docs) may cause memory issues
  **Workaround:** Split your documents into multiple libraries and search them separately

- **Issue:** PDF extraction may fail for encrypted or password-protected PDFs
  **Workaround:** Decrypt PDFs before adding them to the library

- **Issue:** YouTube search requires additional setup
  **Workaround:** Enable YouTube Search in configuration and ensure LM Studio has internet access

## 🚀 Getting Started (Quick Setup)

For most users, the default settings work well:
1. Install the plugin
2. Add some local documents to your RAG library
3. Start researching!

---

## ⚙️ Configuration

| Setting | Description |
| --- | --- |
| **Data Sources** | Web only, Local documents only, or Local documents and web. |
| **Research Depth** | Shallow → Exhaustive. Controls rounds and budgets. |
| **Engine Selection Mode** | Adaptive, Benchmark, or Priority. |
| **Context Budget Mode** | Auto (recommended) scales token limits dynamically. |
| **LLM Call Budget** | Standard = max 45 calls; prevents infinite loops. |
| **LLM Context Isolation** | Strict isolation; prevents history bleed. |
| **Max Session Time** | Hard wall-clock cap (minutes, 20% reserved for synthesis). `0` = no explicit cap (uses global timeout). |
| **Academic APIs** | Query OpenAlex, Crossref, and arXiv directly. |
| **YouTube Search** | Enable YouTube scraping and transcript extraction. |
| **Cache Duration** | Days to reuse visited pages (default 30). `0` disables caching. |
| **FlareSolverr URL** | *Optional:* local Cloudflare bypass endpoint. |
| **SearXNG URL** | *Optional:* local SearXNG instance (default `http://127.0.0.1:8080`). Probed at run start; if unreachable a warning is logged once and the engine falls back to the public `https://searx.be`. Blank = public only. |
| **Decodo Web Scraping API Token** | *Optional:* server-side fetch for TCP-blocked hosts. |
| **Allowed / Blocked Domains** | Comma-separated root-domain allow/deny lists (deny wins). |
| **Max PDF Download Size** | Hard byte cap per PDF (`0` = no cap, may use more disk space). |
| **Max External Plugin Tool Calls** | Per-run cap on `Use Plugin Tool` (`0` = unlimited). |
| **Require Approval Before Writes** | Requires `confirmed: true` for RAG writes / write-capable tools. |
| **Concurrent LLM Calls** | Parallel predictions through the global semaphore (default `1` to prevent model overload). |
| **Include Reasoning Trace** | Append the collapsible reasoning/verification trace to the report. |

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

**When to use which preset:**
- **Shallow:** Quick overviews, fact-checking, simple comparisons
- **Standard:** Balanced research with 3-5 sources per dimension
- **Deep:** Comprehensive analysis, literature reviews
- **Deeper:** Academic research, in-depth technical analysis
- **Exhaustive:** Exhaustive literature reviews, exhaustive searches

## ⚡ Performance Tips

- **Optimize RAG indexing:** Only index documents you actually search. Remove unused libraries.
- **Use appropriate depth:** Shallow depth for quick queries, Exhaustive only when necessary.
- **Model selection:** Use larger models (14B+) for complex reasoning tasks.
- **Cache management:** Clear cache regularly if you encounter stale results.
- **Network optimization:** For web search, use a fast connection to minimize delays.
- **Library organization:** Organize documents by topic to improve search relevance.

## 🤝 Contributing

Contributions are welcome! Areas where help is needed:
- Additional domain/formatting skills
- Bug reports and feature requests
- Documentation improvements
- Testing and feedback

Please read the contributing guidelines before submitting pull requests.

## 📚 Related Resources

- [LM Studio Documentation](https://lmstudio.ai/docs)
- [OpenAlex API](https://docs.openalex.org/)
- [Wikipedia REST API](https://www.mediawiki.org/wiki/API:Main_page)
- [BM25 Algorithm](https://en.wikipedia.org/wiki/Okapi_BM25)

## 📄 License

[MIT License](LICENSE)
