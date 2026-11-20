import { z } from "zod";

/**
 * Structured-output contracts for the LLM-assisted stages. Every field is
 * required (nullable where optional) so the schemas work with provider
 * structured-output modes; Zod re-validates every response locally.
 */

export const AnalysisSchema = z.object({
  intent: z.enum(["chat", "memory_recall", "research", "memory_and_research"]),
  needsMemory: z.boolean().describe("True if answering requires recalling an earlier conversation."),
  needsWebSearch: z.boolean().describe("True if answering requires current facts from the web."),
  standaloneQuestion: z.string().max(600).describe("The request rewritten to be understandable without chat history."),
  entities: z.array(z.string().max(80)).max(12).describe("Products, companies, technologies or topics named or referred to."),
  temporalExpressions: z.array(z.string().max(60)).max(6).describe("Date/time phrases exactly as written, e.g. 'last Tuesday'."),
  asksAboutPricing: z.boolean(),
  asksAboutProductUpdates: z.boolean(),
  searchQueries: z
    .array(z.string().min(2).max(160))
    .max(3)
    .describe("1-3 web search queries that would answer the standalone question (empty if no search is needed)."),
  researchIntent: z
    .enum(["chat", "fact_lookup", "general_research", "comparison", "historical_audit", "pricing_diff"])
    .describe("The kind of research the question needs."),
  aspects: z
    .array(z.string().min(2).max(60))
    .max(6)
    .describe("The specific facets the user asked about or the comparison criteria, short noun phrases (e.g. 'pricing model', 'free tier limits'). Empty if none stated."),
  officialDomains: z
    .array(z.string().max(80))
    .max(3)
    .describe("Official website domains of the named products/projects/organisations if you are confident (e.g. 'nodejs.org', 'react.dev'). Empty if unsure."),
});
export type Analysis = z.infer<typeof AnalysisSchema>;
export type ResearchIntent = Analysis["researchIntent"];

/**
 * General evidence extraction (research pipeline): atomic claims with verbatim quotes, each
 * tagged with the entity and aspect it answers so coverage can be computed in code.
 */
export const ClaimExtractionSchema = z.object({
  claims: z
    .array(
      z.object({
        sourceId: z.string().max(8),
        entity: z.string().max(80).nullable().describe("Which of the listed entities the claim is about, or null."),
        aspect: z.string().max(60).nullable().describe("Which of the listed aspects the claim answers, or null."),
        claim: z.string().min(5).max(300).describe("One atomic factual statement, in your words."),
        quote: z.string().min(8).max(300).describe("Verbatim span from the source that supports the claim."),
      }),
    )
    .max(30),
});
export type ClaimExtraction = z.infer<typeof ClaimExtractionSchema>;

export const PlanSchema = z.object({
  subjects: z
    .array(z.object({ name: z.string().max(80), officialDomain: z.string().max(80).nullable() }))
    .max(8),
  historicalClaims: z
    .array(
      z.object({
        subject: z.string().max(80),
        category: z.enum(["pricing", "product_update", "other"]),
        attribute: z.string().max(80).describe("Plan or aspect, e.g. 'Pro plan' or 'Node 20 end-of-life'."),
        value: z.string().max(160).describe("Value exactly as stated in the earlier answer."),
        messageId: z.string().max(60),
      }),
    )
    .max(20),
  searches: z
    .array(
      z.object({
        query: z.string().min(3).max(160),
        purpose: z.enum(["pricing", "product_update", "general"]),
        subject: z.string().max(80).nullable(),
      }),
    )
    .max(12),
});
export type Plan = z.infer<typeof PlanSchema>;

export const EvidenceExtractionSchema = z.object({
  findings: z
    .array(
      z.object({
        subject: z.string().max(80),
        category: z.enum(["pricing", "other"]),
        attribute: z.string().max(80),
        value: z.string().max(200),
        quote: z.string().max(500).describe("Verbatim text copied from the source that supports the value."),
        sourceId: z.string().max(8),
        planStatus: z.enum(["current", "legacy"]).nullable().optional().describe("'legacy' only if the source says this plan is legacy / no longer offered to new customers."),
        statusQuote: z.string().max(300).nullable().optional().describe("Legacy plans: verbatim text from the same source saying so."),
        successor: z.string().max(80).nullable().optional().describe("Legacy plans: the current plan the source maps it to, if it names one."),
      }),
    )
    .max(40),
  updates: z
    .array(
      z.object({
        subject: z.string().max(80),
        title: z.string().max(200),
        quote: z.string().max(500),
        sourceId: z.string().max(8),
        significance: z.enum(["major", "minor"]),
      }),
    )
    .max(20),
});
export type EvidenceExtraction = z.infer<typeof EvidenceExtractionSchema>;
