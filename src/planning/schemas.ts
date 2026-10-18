// src/planning/schemas.ts
// Single source of truth for the structured-output JSON schemas (item 4).
// LM Studio gets the plain JSON Schema via `structured: { type: "json",
// jsonSchema }`; zod validates the response before it is ever trusted. The
// zodToJsonSchema converter covers exactly the vocabulary these schemas use, so
// the JSON Schema can never drift from the validator.
import { z } from "zod";
import { WorkerRole } from "../types";

export const WORKER_ROLES: ReadonlyArray<WorkerRole> = [
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

const WORKER_ROLE_ENUM = z.enum(WORKER_ROLES as [WorkerRole, ...WorkerRole[]]);

export const researchPlanSchema = z.object({
  workers: z
    .array(
      z.object({
        role: WORKER_ROLE_ENUM,
        label: z.string().min(1),
        queries: z.array(z.string().min(1)).min(1).max(12),
        budgetWeight: z.number().min(0).max(1).default(0.2),
        followLinks: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(10),
  questions: z.array(z.string()).max(12).default([]),
  stopConditions: z.array(z.string()).max(8).default([]),
  estimatedRemainingMs: z.number().nonnegative().default(0),
  citationPolicy: z.literal("index-only"),
  domainTags: z.array(z.string().min(1)).max(8).default([]),
});
export type ResearchPlanParsed = z.infer<typeof researchPlanSchema>;

/**
 * Critic wire schema (LLM-facing). Deliberately FLAT — primitives, booleans, and
 * small enums only, with no nested objects, arrays of objects, or free-form
 * prose. Small local models (Qwen 3.8) emit valid structured output far more
 * reliably this way, and the internal `CriticVerdict` is reconstructed from
 * these flags deterministically in `scoring/critic.ts`.
 */
export const criticVerdictSchema = z.object({
  cardId: z.string().min(1),
  onTopic: z.boolean(),
  hasDate: z.boolean(),
  contradictsLedger: z.boolean(),
  claimStrength: z.enum(["high", "medium", "low"]),
  extractedClaim: z.string().default(""),
  sourceUrl: z.string().default(""),
});
export type CriticVerdictParsed = z.infer<typeof criticVerdictSchema>;

export const criticVerdictBatchSchema = z.object({
  verdicts: z.array(criticVerdictSchema).min(0).max(40),
});
export type CriticVerdictBatchParsed = z.infer<typeof criticVerdictBatchSchema>;

// ---------------------------------------------------------------------------
// zod -> JSON Schema (draft-07 subset). Kept deliberately small: exactly the
// vocabulary used by the schemas above.
// ---------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;

function isOptionalish(schema: z.ZodTypeAny): boolean {
  return (
    schema instanceof z.ZodOptional || schema instanceof z.ZodDefault
  );
}

export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const def = (schema as { _def: { typeName: string } })._def;
  switch (def.typeName) {
    case "ZodObject": {
      const shape = (schema as unknown as z.ZodObject<Record<string, z.ZodTypeAny>>)
        .shape;
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const key of Object.keys(shape)) {
        properties[key] = zodToJsonSchema(shape[key]);
        if (!isOptionalish(shape[key])) required.push(key);
      }
      const result: JsonSchema = { type: "object", properties };
      if (required.length > 0) result.required = required;
      return result;
    }
    case "ZodArray":
      return {
        type: "array",
        items: zodToJsonSchema((schema as unknown as z.ZodArray<z.ZodTypeAny>).element),
      };
    case "ZodString":
      return { type: "string" };
    case "ZodNumber":
      return { type: "number" };
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodEnum":
      return {
        type: "string",
        enum: (schema as unknown as z.ZodEnum<[string, ...string[]]>).options,
      };
    case "ZodUnion":
      return {
        anyOf: (schema as unknown as z.ZodUnion<[z.ZodTypeAny, ...z.ZodTypeAny[]]>)
          .options.map(zodToJsonSchema),
      };
    case "ZodLiteral":
      return { const: (schema as unknown as { value: unknown }).value };
    case "ZodOptional":
      return zodToJsonSchema((schema as unknown as z.ZodOptional<z.ZodTypeAny>).unwrap());
    case "ZodNullable":
      return {
        ...zodToJsonSchema((schema as unknown as z.ZodNullable<z.ZodTypeAny>).unwrap()),
        nullable: true,
      };
    case "ZodDefault":
      return zodToJsonSchema(
        (schema as unknown as z.ZodDefault<z.ZodTypeAny>).removeDefault(),
      );
    default:
      // Conservative: never reject a field we cannot describe.
      return { type: "string" };
  }
}

export const researchPlanJsonSchema = zodToJsonSchema(researchPlanSchema);
export const criticVerdictBatchJsonSchema = zodToJsonSchema(criticVerdictBatchSchema);