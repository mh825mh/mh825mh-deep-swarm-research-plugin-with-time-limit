/**
 * @file scoring/evidence.ts
 * Builds compact Evidence Cards from crawled sources. This is the deterministic
 * (non-LLM) claim-tagging step: it extracts a relevant claim, claim strength
 * classification, verification tier, and confidence so the critic worker can
 * grade the cards and the synthesis can consume a compact graded ledger.
 */

import {
  CrawledSource,
  EvidenceCard,
  ClaimStrength,
  VerificationTier,
} from "../types";
import { DepthProfile } from "../constants";
import { boundEvidenceChunk } from "../utils/text";

export function buildEvidenceCards(
  sources: ReadonlyArray<CrawledSource>,
  profile: DepthProfile,
): ReadonlyArray<EvidenceCard> {
  const excerptChars = Math.max(200, profile.evidenceExcerptChars || 300);
  const claimChars = Math.min(300, Math.round(excerptChars * 0.4));

  return sources.map((s, i) => {
    const domain = safeHostname(s.url);
    const isOfficial = s.domainScore >= 90;

    let claimStrength: ClaimStrength = "speculation";
    const lower = s.text.toLowerCase();
    if (s.tier === "academic" || isOfficial) {
      claimStrength =
        lower.includes("peer-reviewed") || lower.includes("controlled study")
          ? "documented"
          : "disputed";
    } else if (
      lower.includes("interview") ||
      lower.includes("case study") ||
      lower.includes("account")
    ) {
      claimStrength = "anecdote";
    }

    const metadataConfidence = isOfficial ? 1.0 : 0.6;
    const topicFit = s.relevanceScore;
    const recommendationStrength =
      metadataConfidence * 0.4 + topicFit * 0.6;

    let tier: VerificationTier = "C";
    if (isOfficial && recommendationStrength > 0.7) tier = "A";
    else if (recommendationStrength > 0.45) tier = "B";
    if (s.relevanceScore < 0.25) tier = "REJECTED";

    return {
      id: `E${i + 1}`,
      entityType:
        s.tier === "academic"
          ? "article"
          : s.origin === "local"
            ? "local document"
            : "web",
      title: s.title,
      authorOrHost: domain,
      canonicalUrl: s.url,
      // Provenance travels with the card: the resolved URL plus the exact `[n]`
      // anchor the synthesis is expected to emit.
      sourceUrl: s.finalUrl || s.url,
      citationAnchor: `[${i + 1}]`,
      sourceTier: s.tier,
      relevantClaim: boundEvidenceChunk(
        s.description || s.text.slice(0, claimChars),
      ),
      supportingExcerpt: boundEvidenceChunk(s.text.slice(0, excerptChars)),
      confidence:
        s.relevanceScore > 0.6
          ? "High"
          : s.relevanceScore > 0.35
            ? "Medium"
            : "Low",
      claimStrength,
      freshness: s.published,
      worker: s.workerLabel,
      verificationTier: tier,
      metadataConfidence,
      topicFit,
      recommendationStrength,
      entityMetadata: { publisher: domain, officialUrl: s.url },
    };
  });
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}