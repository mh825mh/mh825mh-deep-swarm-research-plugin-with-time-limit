import { logLlmDiagnostics } from "../utils/tokens";
import {
  askLoadedModel,
  askStructured,
  ReasoningCapture,
  getLastLlmError,
  resetLastLlmError,
} from "../utils/llm";
import { extractQwenJson } from "../utils/qwen-parser";
import { buildCoreTopicQuery, capQueryKeywords } from "../utils/topicQuery";
import { buildKvCachePinnedMessages } from "../swarm/singleflightAndSnippetGate";
import {
  QueryPlan,
  WorkerRole,
  DynamicWorkerSpec,
  AdaptiveGapPlan,
  CrawledSource,
  AgentMessage,
  StatusFn,
  ResearchPlan,
} from "../types";
import {
  researchPlanSchema,
  researchPlanJsonSchema,
  ResearchPlanParsed,
} from "./schemas";
import { DIMENSIONS, detectGaps, gapFillQueries } from "./dimensions";
import {
  DepthProfile,
  AI_PLANNING_MAX_TOKENS,
  AI_PLANNING_TEMPERATURE,
  AI_PLANNING_TIMEOUT_MS,
  AI_MIN_ACCEPTABLE_QUERIES,
  AI_DECOMPOSITION_MAX_TOKENS,
  AI_DECOMPOSITION_TEMPERATURE,
  AI_DECOMPOSITION_TIMEOUT_MS,
  AI_FINDINGS_SUMMARY_MAX_TOKENS,
  AI_FINDINGS_SUMMARY_TEMPERATURE,
  FINDINGS_SUMMARY_SOURCE_CHARS,
  DECOMPOSITION_MIN_WORKERS,
  QUERY_LINE_MIN_LEN,
  QUERY_LINE_MAX_LEN,
  MAX_GENERATED_QUERY_WORDS,
  STANDARD_MAX_GAP_QUERIES,
  STANDARD_MAX_GAP_WORKERS,
  SYSTEM_INSTRUCTIONS,
  THINKING_PROTOCOL,
} from "../constants";

/**
 * Planner system prompt. Begins with the shared `STATIC_SWARM_SYSTEM_PREFIX`
 * (from the KV-cache pinner) so the planner reuses the same warm prefix as the
 * later critic/synthesis calls within a run, then adds the thinking rubric.
 */
const PLANNER_SYSTEM = `${buildKvCachePinnedMessages(undefined, "PLANNER", "").system}\n\n${SYSTEM_INSTRUCTIONS}\n\n${THINKING_PROTOCOL}`;

async function callLoadedModel(
  prompt: string,
  maxTokens: number = AI_PLANNING_MAX_TOKENS,
  temperature: number = AI_PLANNING_TEMPERATURE,
  timeoutMs: number = AI_PLANNING_TIMEOUT_MS,
  opts: { system?: string; capture?: ReasoningCapture } = {},
): Promise<string | null> {
  return askLoadedModel(prompt, {
    system: opts.system ?? SYSTEM_INSTRUCTIONS,
    maxTokens,
    temperature,
    timeoutMs,
    // Planning benefits from the model's reasoning; keep thinking on.
    reasoningEffort: "high",
    capture: opts.capture,
  });
}

function parseLines(raw: string, maxLines: number = 6): ReadonlyArray<string> {
  return raw
    .split(/\n/)
    .map((line) => line.replace(/^\d+[.)]\s*|^[-*•]\s*/, "").trim())
    .filter(
      (line) =>
        line.length > QUERY_LINE_MIN_LEN && line.length < QUERY_LINE_MAX_LEN,
    )
    .filter((line, idx, arr) => arr.indexOf(line) === idx)
    .slice(0, maxLines);
}

const VALID_ROLES: ReadonlyArray<WorkerRole> = [
  "breadth",
  "depth",
  "recency",
  "academic",
  "critical",
  "statistical",
  "regulatory",
  "technical",
  "primary",
  "comparative",
];

function makeDecompositionPrompt(
  topic: string,
  focusAreas: ReadonlyArray<string>,
  profile: DepthProfile,
): string {
  const focus = focusAreas.length
    ? `\nFocus areas: ${focusAreas.join(", ")}`
    : "";
  return `You are a research decomposition system. Given a research topic, output a strict JSON object describing a swarm of specialized workers.
Topic: "${topic}"${focus}

The JSON object MUST have these keys:
"workers": array of worker objects, each with:
  "role": one of "breadth", "depth", "recency", "academic", "critical", "statistical", "regulatory", "technical", "primary", "comparative"
  "label": descriptive name (e.g., "Clinical Evidence Researcher", "Policy Critic")
  "queries": array of ${Math.min(profile.maxQueriesPerWorker, 6)}-${profile.maxQueriesPerWorker} specific, natural search queries
  "budgetWeight": number 0.1-0.4
  "followLinks": boolean
"questions": 3-5 open questions the research must answer (string array)
"stopConditions": 2-4 concrete stopping conditions (string array), e.g. "Found 3 primary sources confirming Q2"
"estimatedRemainingMs": your estimate of the time this plan needs, as a number (milliseconds)
"citationPolicy": "index-only"
"domainTags": 2-5 concise domain tags describing the topic's field, e.g. "medicine", "history", "policy", "technology", "business" (string array)

Rules:
1. Output ${DECOMPOSITION_MIN_WORKERS} to ${profile.maxDecompositionWorkers} workers.
2. Queries must be human-like search strings (under 8 words). DO NOT just mash the topic and role together.
3. Output ONLY valid JSON. No conversational text.

JSON:`;
}

function researchPlanFromParsed(parsed: ResearchPlanParsed): ResearchPlan {
  const workers: DynamicWorkerSpec[] = parsed.workers.map((w) => ({
    role: w.role,
    label: w.label,
    queries: w.queries,
    budgetWeight: w.budgetWeight,
    followLinks: w.followLinks,
  }));
  return {
    workers,
    questions: parsed.questions,
    stopConditions: parsed.stopConditions,
    estimatedRemainingMs: parsed.estimatedRemainingMs,
    citationPolicy: "index-only",
    domainTags: parsed.domainTags,
  };
}

async function aiDecompose(
  topic: string,
  focusAreas: ReadonlyArray<string>,
  status: StatusFn,
  profile: DepthProfile,
  onLlmSuccess?: () => void,
): Promise<{ plan: ResearchPlan | null; reasoning: string }> {
  const prompt = makeDecompositionPrompt(topic, focusAreas, profile);
  const capture: ReasoningCapture = { trace: "" };

  // Preferred path: native structured output (JSON schema) with zod validation.
  const structured = await askStructured(prompt, researchPlanSchema, {
    system: PLANNER_SYSTEM,
    jsonSchema: researchPlanJsonSchema,
    maxTokens: AI_DECOMPOSITION_MAX_TOKENS,
    temperature: AI_DECOMPOSITION_TEMPERATURE,
    timeoutMs: AI_DECOMPOSITION_TIMEOUT_MS,
    reasoningEffort: "high",
    capture,
  });
  const structuredReasoning = capture.trace;
  if (structured) {
    const plan = researchPlanFromParsed(structured);
    if (plan.workers.length >= DECOMPOSITION_MIN_WORKERS) {
      onLlmSuccess?.();
      status(
        `AI decomposed topic into ${plan.workers.length} structured workers (tags: ${plan.domainTags.join(", ") || "none"})`,
      );
      return { plan, reasoning: structuredReasoning };
    }
  }

  // Best-effort fallback: free-text JSON + manual parse.
  const raw = await callLoadedModel(
    prompt,
    AI_DECOMPOSITION_MAX_TOKENS,
    AI_DECOMPOSITION_TEMPERATURE,
    AI_DECOMPOSITION_TIMEOUT_MS,
    { system: PLANNER_SYSTEM, capture },
  );
  const reasoning = capture.trace || structuredReasoning;
  if (!raw) return { plan: null, reasoning };
  onLlmSuccess?.();
  try {
    const parsed = extractQwenJson<any>(raw);
    const list = Array.isArray(parsed) ? parsed : parsed.workers;
    if (!Array.isArray(list) || list.length < DECOMPOSITION_MIN_WORKERS)
      return { plan: null, reasoning };
    const specs: DynamicWorkerSpec[] = [];
    for (const item of list.slice(0, profile.maxDecompositionWorkers)) {
      const role = VALID_ROLES.includes(item.role) ? item.role : "breadth";
      const queries = Array.isArray(item.queries)
        ? item.queries
            .filter((q: unknown) => typeof q === "string" && q.length > 3)
            .slice(0, profile.maxQueriesPerWorker)
        : [];
      if (queries.length < 2) continue;
      specs.push({
        role: role as WorkerRole,
        label:
          typeof item.label === "string"
            ? item.label.slice(0, 60)
            : `${role} worker`,
        queries,
        budgetWeight:
          typeof item.budgetWeight === "number"
            ? Math.max(0.05, Math.min(0.5, item.budgetWeight))
            : 0.2,
        followLinks: item.followLinks === true,
        preferredTiers: Array.isArray(item.preferredTiers)
          ? item.preferredTiers
          : undefined,
      });
    }
    if (specs.length < DECOMPOSITION_MIN_WORKERS) return { plan: null, reasoning };
    const totalWeight = specs.reduce((sum, s) => sum + s.budgetWeight, 0);
    const normalised = specs.map((s) => ({
      ...s,
      budgetWeight: s.budgetWeight / totalWeight,
    }));
    const domainTags = Array.isArray(parsed.domainTags)
      ? parsed.domainTags.filter(
          (t: unknown) => typeof t === "string" && t.length > 1,
        )
      : [];
    const plan: ResearchPlan = {
      workers: normalised,
      questions: Array.isArray(parsed.questions)
        ? parsed.questions.filter((q: unknown) => typeof q === "string")
        : [],
      stopConditions: Array.isArray(parsed.stopConditions)
        ? parsed.stopConditions.filter((s: unknown) => typeof s === "string")
        : [],
      estimatedRemainingMs:
        typeof parsed.estimatedRemainingMs === "number"
          ? parsed.estimatedRemainingMs
          : 0,
      citationPolicy: "index-only",
      domainTags,
    };
    status(`AI decomposed topic into ${normalised.length} specialised workers`);
    return { plan, reasoning };
  } catch {
    return { plan: null, reasoning };
  }
}

function makeRolePlanPrompt(
  role: WorkerRole,
  topic: string,
  focusAreas: ReadonlyArray<string>,
  profile: DepthProfile,
): string {
  const roleDescriptions: Readonly<Record<WorkerRole, string>> = {
    breadth: "broad coverage - primary facts, key individuals, organizations, and canonical entities",
    depth: "deep dive - experimental methodologies, field investigations, and primary case data",
    recency: "recent developments - publications, peer reviews, and verifiable records from 2024-2026",
    academic: "academic papers - peer-reviewed studies, university archives, and institutional research",
    critical: "skeptical analysis - methodological critiques, counter-arguments, fraud investigations, and alternative explanations",
    statistical: "statistics and quantitative findings - sample sizes, replication rates, and surveys",
    regulatory: "governing standards, institutional positions, and formal guidelines",
    technical: "technical mechanisms and specific evaluation frameworks",
    primary: "primary documentation - field notes, first-hand interviews, and official recordings",
    comparative: "comparative models - alternative scientific, physiological, or psychological hypotheses",
  };

  const focus = focusAreas.length ? `\nFocus areas: ${focusAreas.join(", ")}` : "";

  return `You are an expert investigative search planner.
Target Topic: "${topic}"${focus}
Assigned Role: ${roleDescriptions[role]}

Generate exactly ${profile.maxQueriesPerWorker} precision search queries.

STRICT QUERY RULES:
1. Target canonical entities, notable researchers, research institutes, and key published works directly.
2. If the topic is empirical/scientific, append negative terms when appropriate (e.g., -livestream -forum -llm) to filter junk.
3. If this role is "critical", explicitly hunt for critiques, failed replications, and skeptics.
4. Output ONLY the queries, one per line. No numbering, quotes, or Markdown formatting.

Queries:`;
}

const ROLE_DIMENSIONS: Readonly<Record<WorkerRole, ReadonlyArray<string>>> = {
  breadth: ["overview", "applications", "history", "economics"],
  depth: ["mechanism", "evidence", "expert"],
  recency: ["current", "future"],
  academic: ["evidence", "expert", "mechanism"],
  critical: ["challenges", "controversy", "comparison"],
  statistical: ["evidence", "economics", "overview"],
  regulatory: ["challenges", "controversy", "current"],
  technical: ["mechanism", "applications", "evidence"],
  primary: ["evidence", "expert", "history"],
  comparative: ["comparison", "challenges", "applications"],
};

const COMMERCIAL_TOPIC_RE =
  /\b(market|pricing|price|revenue|competitor|valuation|saas|stock|finance|financial|business|startup|b2b|roi|cost|buyout|industry|commerce|ecommerce|monetization|sales)\b/i;

const SAAS_QUERY_RE =
  /\b(roi|pricing|market size|economic impact|barriers to adoption|practical deployment|implementation case studies|who invented|market growth|revenue forecast|financial impact|use cases industry|competitors|benchmark comparison|industry expert)\b/i;

/** True when the topic or AI domain tags explicitly belong to a commercial/software domain. */
export function isCommercialTopic(
  topic: string,
  domainTags: ReadonlyArray<string> = [],
): boolean {
  return COMMERCIAL_TOPIC_RE.test(`${topic} ${domainTags.join(" ")}`);
}

/**
 * Standard-depth AI plans must not expand into every hardcoded role or dump
 * four queries per worker. Cap workers/queries and strip commercial boilerplate
 * from non-commercial topics.
 */
export function capDynamicWorkerQueries(
  specs: ReadonlyArray<DynamicWorkerSpec>,
  maxWorkers: number,
  maxQueries: number,
  topic: string,
  domainTags: ReadonlyArray<string> = [],
): DynamicWorkerSpec[] {
  const commercial = isCommercialTopic(topic, domainTags);
  const capped: DynamicWorkerSpec[] = [];

  for (const spec of specs.slice(0, Math.max(1, maxWorkers))) {
    const queries = spec.queries
      .map((q) => capQueryKeywords(q, MAX_GENERATED_QUERY_WORDS))
      .filter(Boolean)
      .filter((q) => commercial || !SAAS_QUERY_RE.test(q))
      .slice(0, Math.max(1, maxQueries));

    if (queries.length > 0) capped.push({ ...spec, queries });
  }

  return capped;
}

function dimensionFallbackQueries(
  role: WorkerRole,
  topic: string,
  focusAreas: ReadonlyArray<string>,
  maxQueries: number,
): ReadonlyArray<string> {
  const dimIds = ROLE_DIMENSIONS[role];
  const commercial = isCommercialTopic(topic);
  // Applications/economics are SaaS/market boilerplate for a theology or
  // history topic. Only include them when the topic is explicitly commercial.
  const dims = DIMENSIONS.filter(
    (d) =>
      dimIds.includes(d.id) &&
      (commercial ||
        !["applications", "economics", "comparison"].includes(d.id)),
  );
  const queries: string[] = [];

  // BUGFIX: Actually use the shortenTopic function to strip the massive prompt
  const shortTopic = shortenTopic(topic);

  for (const dim of dims) {
    for (const q of dim.queries(shortTopic)) {
      const capped = capQueryKeywords(q, MAX_GENERATED_QUERY_WORDS);
      if (!capped || queries.includes(capped)) continue;
      if (!commercial && SAAS_QUERY_RE.test(capped)) continue;
      queries.push(capped);
    }
  }
  for (const area of focusAreas) {
    const q = capQueryKeywords(`${shortTopic} ${area}`, MAX_GENERATED_QUERY_WORDS);
    if (!q || queries.includes(q)) continue;
    if (!commercial && SAAS_QUERY_RE.test(q)) continue;
    queries.push(q);
  }
  return queries.slice(0, maxQueries);
}

export async function buildQueryPlan(
  topic: string,
  focusAreas: ReadonlyArray<string>,
  useAI: boolean,
  status: StatusFn,
  profile: DepthProfile,
  onLlmSuccess?: () => void,
): Promise<QueryPlan> {
  resetLastLlmError();
  const CORE_ROLES: ReadonlyArray<WorkerRole> = [
    "breadth",
    "depth",
    "recency",
    "academic",
    "critical",
  ];
  const EXTENDED_ROLES: ReadonlyArray<WorkerRole> = [
    "statistical",
    "regulatory",
    "technical",
    "primary",
    "comparative",
  ];
  let roles: ReadonlyArray<WorkerRole>;
  if (profile.depthRounds >= 10) {
    roles = [...CORE_ROLES, ...EXTENDED_ROLES];
  } else if (profile.depthRounds >= 5) {
    roles = [...CORE_ROLES, "technical", "comparative", "statistical"];
  } else {
    roles = CORE_ROLES;
  }
  const queriesByRole: Partial<Record<WorkerRole, ReadonlyArray<string>>> = {};
  let usedAI = false;
  let dynamicSpecs: ReadonlyArray<DynamicWorkerSpec> | undefined;
  let researchPlan: ResearchPlan | undefined;
  let domainTags: ReadonlyArray<string> | undefined;
  let plannerReasoning = "";
  const standardDepth = profile.depthRounds <= 3;
  const workerCap = standardDepth
    ? Math.min(STANDARD_MAX_GAP_WORKERS, profile.maxDecompositionWorkers)
    : profile.maxDecompositionWorkers;
  const queryCap = standardDepth
    ? Math.min(STANDARD_MAX_GAP_QUERIES, profile.maxQueriesPerWorker)
    : profile.maxQueriesPerWorker;
  const commercialTopic = isCommercialTopic(topic);

  if (useAI) {
    status("AI task decomposition - analysing topic for specialised workers...");
    const decomposition = await aiDecompose(
      topic,
      focusAreas,
      status,
      profile,
      onLlmSuccess,
    );
    const plan = decomposition.plan;
    plannerReasoning = decomposition.reasoning;
    if (plan && plan.workers.length >= DECOMPOSITION_MIN_WORKERS) {
      // Respect the AI plan: cap it, strip SaaS boilerplate, and do NOT expand
      // into hardcoded roles. This is what used to become 9 workers x 4 queries.
      const capped = capDynamicWorkerQueries(
        plan.workers,
        workerCap,
        queryCap,
        topic,
        plan.domainTags,
      );
      if (capped.length >= DECOMPOSITION_MIN_WORKERS) {
        dynamicSpecs = capped;
        researchPlan = plan;
        domainTags = plan.domainTags;
        usedAI = true;
        for (const spec of capped) {
          queriesByRole[spec.role] = spec.queries;
        }
      }
    }

    if (!dynamicSpecs) {
      status("AI planning queries for each swarm worker...");
      const uncoveredRoles = roles.filter((r) => !queriesByRole[r]?.length);
      if (uncoveredRoles.length > 0) {
        const results = await Promise.allSettled(
          uncoveredRoles.map(async (role) => ({
            role,
            queries: await callLoadedModel(
              makeRolePlanPrompt(role, topic, focusAreas, profile),
            ),
          })),
        );
        for (const result of results) {
          if (result.status !== "fulfilled") continue;
          const { role, queries: raw } = result.value;
          if (!raw) continue;
          onLlmSuccess?.();
          const parsed = parseLines(raw, queryCap)
            .map((q) => capQueryKeywords(q, MAX_GENERATED_QUERY_WORDS))
            .filter(Boolean)
            .filter((q) => commercialTopic || !SAAS_QUERY_RE.test(q));
          if (parsed.length >= Math.min(AI_MIN_ACCEPTABLE_QUERIES, queryCap)) {
            queriesByRole[role] = parsed;
            usedAI = true;
          }
        }
      }
    }

    if (usedAI) {
      status(
        `AI generated queries for ${Object.keys(queriesByRole).length} worker role(s)`,
      );
    } else {
      const reason = getLastLlmError();
      status(
        `AI unavailable${reason ? ` (${reason})` : ""}, using dimension-based query planning`,
      );
    }
  }

  // Only synthesize hardcoded-role fallbacks when the AI plan did not supply
  // worker specs. Otherwise the 4-5 AI workers are the complete worker set.
  if (!dynamicSpecs) {
    for (const role of roles) {
      if (!queriesByRole[role] || queriesByRole[role]!.length === 0) {
        queriesByRole[role] = dimensionFallbackQueries(
          role,
          topic,
          focusAreas,
          queryCap,
        );
      }
    }
  }
  
  const topicKeywords = extractKeywords(topic);

  // PRE-SEARCH PLANNING (If AI is enabled)
  if (useAI) {
    const planPrompt = `Topic: ${topic}\nFocus: ${focusAreas.join(", ")}\n
    Generate a JSON object with:
    1. "subQuestions": 3-5 specific questions to answer.
    2. "likelySourceTypes": Array of strings (e.g., "academic", "news", "reference").
    3. "stopConditions": Array of strings (e.g., "Found 3 sources confirming Q3 revenue").`;
    
    logLlmDiagnostics("buildQueryPlan-PreSearch", planPrompt);
  }

  return {
    queriesByRole: queriesByRole as Record<WorkerRole, ReadonlyArray<string>>,
    usedAI,
    topicKeywords,
    dynamicSpecs,
    researchPlan,
    domainTags,
    plannerReasoning: plannerReasoning || undefined,
  };
} 

export async function summariseFindings(
  sources: ReadonlyArray<CrawledSource>,
  topic: string,
  useAI: boolean,
  status: StatusFn,
): Promise<ReadonlyArray<AgentMessage>> {
  if (!useAI || sources.length === 0) return [];
  const sourceSummaries = sources
    .slice(0, 20)
    .map(
      (s, i) =>
        `[${i + 1}] ${s.workerLabel}: ${s.title} - ${s.text.slice(0, FINDINGS_SUMMARY_SOURCE_CHARS)}`,
    )
    .join("\n\n");
  const prompt = `You are a research coordinator. A team of research agents collected these sources on "${topic}":
${sourceSummaries}
Summarise:
The 3-5 most important findings discovered so far (one line each)
3-5 specific questions or angles that were NOT covered and need follow-up
Output format:
FINDINGS:
finding 1
finding 2
...
FOLLOW_UP:
question 1
question 2
...`;
  const raw = await callLoadedModel(
    prompt,
    AI_FINDINGS_SUMMARY_MAX_TOKENS,
    AI_FINDINGS_SUMMARY_TEMPERATURE,
  );
  if (!raw) return [];
  const findings: string[] = [];
  const followUps: string[] = [];
  let section: "findings" | "followup" | null = null;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (/^FINDINGS:/i.test(trimmed)) {
      section = "findings";
      continue;
    }
    if (/^FOLLOW.?UP:/i.test(trimmed)) {
      section = "followup";
      continue;
    }
    const item = trimmed.replace(/^[-*•]\s*/, "").trim();
    if (item.length < 5) continue;
    if (section === "findings") findings.push(item);
    if (section === "followup") followUps.push(item);
  }
  if (findings.length === 0 && followUps.length === 0) return [];
  status(
    `AI summarised ${findings.length} key findings, ${followUps.length} follow-up suggestions`,
  );
  return [
    {
      fromWorker: "round-coordinator",
      keyFindings: findings,
      suggestedFollowUps: followUps,
    },
  ];
}

const GAP_ROLE_MAP: Readonly<
  Record<
    string,
    {
      role: WorkerRole;
      followLinks: boolean;
      tiers?: ReadonlyArray<import("../types").SourceTier>;
    }
  >
> = {
  overview: { role: "breadth", followLinks: false },
  mechanism: { role: "technical", followLinks: true },
  history: { role: "breadth", followLinks: false },
  current: { role: "recency", followLinks: false },
  applications: { role: "breadth", followLinks: false },
  challenges: { role: "critical", followLinks: false },
  comparison: { role: "comparative", followLinks: false },
  evidence: {
    role: "academic",
    followLinks: true,
    tiers: ["academic", "government", "reference"],
  },
  expert: { role: "primary", followLinks: true, tiers: ["academic", "news"] },
  future: { role: "recency", followLinks: false },
  controversy: { role: "critical", followLinks: false },
  economics: { role: "statistical", followLinks: false },
};

export async function buildAdaptiveGapFill(
  topic: string,
  coveredIds: ReadonlyArray<string>,
  priorMessages: ReadonlyArray<AgentMessage>,
  useAI: boolean,
  status: StatusFn,
  profile: DepthProfile,
): Promise<ReadonlyArray<AdaptiveGapPlan>> {
  const gaps = detectGaps(coveredIds);
  if (gaps.length === 0) {
    status("All research dimensions covered - no gap queries needed");
    return [];
  }
  status(`Gaps: ${gaps.map((g) => g.label).join(", ")}`);
  const byRole = new Map<
    WorkerRole,
    {
      dimIds: string[];
      dimLabels: string[];
      queries: string[];
      followLinks: boolean;
      tiers?: ReadonlyArray<import("../types").SourceTier>;
    }
  >();
  
  // BUGFIX: Shorten the topic here too so the fallback queries are clean
  const shortTopic = shortenTopic(topic);
  
  for (const gap of gaps) {
    const mapping = GAP_ROLE_MAP[gap.id] ?? {
      role: "breadth" as WorkerRole,
      followLinks: false,
    };
    const existing = byRole.get(mapping.role) ?? {
      dimIds: [],
      dimLabels: [],
      queries: [],
      followLinks: mapping.followLinks,
      tiers: mapping.tiers,
    };
    existing.dimIds.push(gap.id);
    existing.dimLabels.push(gap.label);
    existing.queries.push(
      ...gap
        .queries(shortTopic)
        .filter((q) => isCommercialTopic(topic) || !SAAS_QUERY_RE.test(q)),
    );
    byRole.set(mapping.role, existing);
  }
  if (useAI) {
    const followUpContext = priorMessages
      .flatMap((m) => m.suggestedFollowUps)
      .slice(0, 6);
    const entries = Array.from(byRole.entries());
    const aiResults = await Promise.allSettled(
      entries.map(async ([role, group]) => {
        const queryCount = Math.min(
          group.dimLabels.length * 3,
          profile.maxGapFillQueries,
        );
        const prompt = `You are an expert Google searcher. A research session on "${topic}" is missing these angles:
${group.dimLabels.join(", ")}
${followUpContext.length > 0 ? `Previous round suggested exploring:\n${followUpContext.join("\n")}\n` : ""}

Generate ${queryCount} specific, natural search engine queries to fill these gaps.

Rules:
1. DO NOT just append words to the topic string. Write human-like search queries.
2. Keep queries short and concise.
3. Return ONLY the queries, one per line. No numbering, no prefixes.

Queries:`;
        return { role, raw: await callLoadedModel(prompt) };
      }),
    );
    for (const result of aiResults) {
      if (result.status !== "fulfilled" || !result.value.raw) continue;
      const { role, raw } = result.value;
      const parsed = parseLines(raw, profile.maxGapFillQueries);
      if (parsed.length >= 2) {
        const group = byRole.get(role);
        if (group) group.queries = [...parsed];
      }
    }
  }
  const plans: AdaptiveGapPlan[] = [];
  for (const [role, group] of byRole) {
    plans.push({
      role,
      label: `Gap-fill: ${group.dimLabels.slice(0, 3).join(", ")}`,
      queries: group.queries
        .map((query) => capQueryKeywords(query, MAX_GENERATED_QUERY_WORDS))
        .filter(Boolean)
        .filter((query) => isCommercialTopic(topic) || !SAAS_QUERY_RE.test(query))
        .slice(0, profile.maxGapFillQueries),
      followLinks: group.followLinks,
      preferredTiers: group.tiers,
    });
  }
  status(`${plans.length} adaptive gap-fill worker(s) planned`);
  return plans;
}

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "in", "of", "and", "or", "for", "to", "how", "what",
  "why", "when", "does", "with", "from", "that", "could", "which", "about",
  "their", "this", "these", "those", "would", "should", "current",
  "hypothetical", "scenarios", "lead",
]);

// Words that appear across many unrelated topics. Keeping them as topic
// keywords lets off-topic pages slip past the relevance gate (e.g. a topic
// like "evidence about reincarnation" must not be satisfied by any page that
// merely mentions "evidence"). Drop them so only distinctive terms remain.
const GENERIC_TOPIC_WORDS = new Set([
  "evidence", "research", "study", "studies", "analysis", "analyses",
  "information", "findings", "data", "results", "result", "review", "reviews",
  "role", "roles", "key", "impact", "effects", "effect", "implications",
  "system", "systems", "about", "based", "related", "around", "overview",
  "recent", "latest", "current", "future", "questions", "question", "issues",
  "issue", "aspects", "nature", "types", "trends", "examples", "reasons",
]);

function extractKeywords(topic: string): ReadonlyArray<string> {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w) && !GENERIC_TOPIC_WORDS.has(w))
    .slice(0, 8);
}

function shortenTopic(topic: string): string {
  const colonIdx = topic.indexOf(":");
  const dashIdx = topic.indexOf(" - ");
  const sepIdx = colonIdx > 3 ? colonIdx : dashIdx > 3 ? dashIdx : -1;
  const core =
    sepIdx > 3 && sepIdx < topic.length * 0.6
      ? topic.slice(0, sepIdx).trim()
      : topic;

  // buildCoreTopicQuery strips site: operators, framing words, and caps the
  // keyword count. Keep the fallback short enough that a 1-4 word suffix still
  // fits inside the 10-keyword ceiling.
  const cleaned = buildCoreTopicQuery(core, 5);
  return cleaned.length >= 3 ? cleaned : buildCoreTopicQuery(topic, 5);
}