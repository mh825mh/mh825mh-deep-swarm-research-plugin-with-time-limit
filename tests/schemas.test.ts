import { describe, it, expect } from "vitest";
import {
  researchPlanSchema,
  criticVerdictBatchSchema,
  researchPlanJsonSchema,
  criticVerdictBatchJsonSchema,
  zodToJsonSchema,
} from "../src/planning/schemas";
import { z } from "zod";

describe("zodToJsonSchema", () => {
  it("mirrors leaf types", () => {
    expect(zodToJsonSchema(z.string())).toEqual({ type: "string" });
    expect(zodToJsonSchema(z.number())).toEqual({ type: "number" });
    expect(zodToJsonSchema(z.boolean())).toEqual({ type: "boolean" });
  });

  it("marks required + optional object fields (defaults are not required)", () => {
    const schema = z.object({
      a: z.string(),
      b: z.number().default(1),
    });
    const json = zodToJsonSchema(schema) as Record<string, unknown>;
    expect(json.type).toBe("object");
    expect(json.required).toEqual(["a"]);
    expect((json.properties as Record<string, unknown>).a).toEqual({ type: "string" });
    expect((json.properties as Record<string, unknown>).b).toEqual({ type: "number" });
  });

  it("describes enums, arrays, and literals", () => {
    const schema = z.object({
      role: z.enum(["a", "b"]),
      tags: z.array(z.string()).default([]),
      policy: z.literal("index-only"),
    });
    const json = zodToJsonSchema(schema) as Record<string, unknown>;
    const props = json.properties as Record<string, unknown>;
    expect(props.role).toEqual({ type: "string", enum: ["a", "b"] });
    expect(props.tags).toEqual({ type: "array", items: { type: "string" } });
    expect(props.policy).toEqual({ const: "index-only" });
  });

  it("never emits an empty required list", () => {
    const json = zodToJsonSchema(z.object({ x: z.string().optional() })) as Record<string, unknown>;
    expect(json.required).toBeUndefined();
  });
});

describe("researchPlanSchema", () => {
  it("accepts a valid structured plan and applies defaults", () => {
    const plan = researchPlanSchema.parse({
      workers: [
        {
          role: "academic",
          label: "Clinical Evidence Researcher",
          queries: ["clinical evidence reincarnation", "peer reviewed case studies reincarnation"],
        },
      ],
      questions: ["Is the evidence documented?"],
      stopConditions: [],
      estimatedRemainingMs: 60000,
      citationPolicy: "index-only",
      domainTags: ["medicine", "psychology"],
    });

    expect(plan.workers[0].budgetWeight).toBe(0.2);
    expect(plan.workers[0].followLinks).toBe(false);
    expect(plan.domainTags).toEqual(["medicine", "psychology"]);
    expect(plan.citationPolicy).toBe("index-only");
  });

  it("rejects a plan with no workers and a non-index-only policy", () => {
    expect(
      researchPlanSchema.safeParse({ workers: [], citationPolicy: "free" }).success,
    ).toBe(false);
  });

  it("the generated JSON schema is usable as a plain JSON Schema", () => {
    expect(researchPlanJsonSchema.type).toBe("object");
    const props = (researchPlanJsonSchema as any).properties as Record<string, any>;
    expect(props.workers.type).toBe("array");
    expect(props.citationPolicy.const).toBe("index-only");
    expect(props.domainTags).toBeDefined();
  });
});

describe("criticVerdictBatchSchema", () => {
  it("validates a flat batch of verdicts with defaults applied", () => {
    const batch = criticVerdictBatchSchema.parse({
      verdicts: [
        {
          cardId: "E1",
          onTopic: true,
          hasDate: true,
          contradictsLedger: false,
          claimStrength: "high",
        },
      ],
    });
    // Flat, prose-free wire shape: only primitives, booleans, and enums.
    expect(batch.verdicts[0].extractedClaim).toBe("");
    expect(batch.verdicts[0].sourceUrl).toBe("");
    expect(batch.verdicts[0].hasDate).toBe(true);
    expect(batch.verdicts[0].contradictsLedger).toBe(false);
  });

  it("rejects a batch missing required booleans", () => {
    expect(
      criticVerdictBatchSchema.safeParse({
        verdicts: [
          {
            cardId: "E1",
            onTopic: true,
            claimStrength: "high",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects a batch with an unknown claimStrength", () => {
    expect(
      criticVerdictBatchSchema.safeParse({
        verdicts: [
          {
            cardId: "E1",
            onTopic: true,
            hasDate: true,
            contradictsLedger: false,
            claimStrength: "maybe",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("the generated JSON schema exposes the flat verdict enum + array", () => {
    const props = (criticVerdictBatchJsonSchema as any).properties as Record<string, any>;
    expect(props.verdicts.type).toBe("array");
    const verdict = props.verdicts.items as Record<string, any>;
    // Second level only: primitive-typed properties, no nested objects.
    expect(verdict.properties.claimStrength.enum).toEqual(["high", "medium", "low"]);
    expect(verdict.properties.onTopic.type).toBe("boolean");
    expect(verdict.properties.hasDate.type).toBe("boolean");
    expect(verdict.properties.contradictsLedger.type).toBe("boolean");
    for (const value of Object.values(verdict.properties) as any[]) {
      expect(value.type === "object" || value.type === "array").toBe(false);
    }
  });
});