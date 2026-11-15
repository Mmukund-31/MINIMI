import { z } from "zod";

const UNSUPPORTED_KEYWORDS = new Set([
  "$schema",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minItems",
  "maxItems",
  "pattern",
  "format",
  "default",
]);

/**
 * Converts a Zod schema to a JSON Schema that provider structured-output
 * modes accept: objects are closed (`additionalProperties: false`) and
 * validation-only keywords are stripped. The full Zod schema is still
 * enforced locally after the response arrives.
 */
export function toProviderJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { target: "draft-7", unrepresentable: "any" }) as Record<string, unknown>;
  return sanitize(raw) as Record<string, unknown>;
}

function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (UNSUPPORTED_KEYWORDS.has(k)) continue;
    out[k] = sanitize(v);
  }
  if (out.type === "object") {
    out.additionalProperties = false;
    if (out.properties && typeof out.properties === "object") {
      out.required = Object.keys(out.properties as object);
    }
  }
  return out;
}

/**
 * Extracts a JSON value from model text: tolerates code fences and leading
 * prose. Throws SyntaxError when no JSON object can be parsed.
 */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // continue
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      // continue
    }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new SyntaxError("No JSON object found in model output");
}

export type ValidationOutcome<T> = { ok: true; data: T } | { ok: false; error: string };

export function validateJson<T>(schema: z.ZodType<T>, text: string): ValidationOutcome<T> {
  let value: unknown;
  try {
    value = parseJsonLoose(text);
  } catch (err) {
    return { ok: false, error: `Output was not valid JSON: ${(err as Error).message}` };
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, data: parsed.data };
  const issues = parsed.error.issues
    .slice(0, 8)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  return { ok: false, error: `Output did not match the schema: ${issues}` };
}
