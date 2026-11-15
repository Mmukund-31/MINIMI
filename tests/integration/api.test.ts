/** HTTP-level tests via Fastify inject (no network, deterministic doubles). */
import { afterAll, describe, expect, it } from "vitest";
import { buildServer } from "../../apps/api/src/server";
import { crmMessage, crmScript, crmSearch } from "../../evals/fixtures/demo-fixtures";
import { makeRuntime } from "../helpers";

const parseSse = (body: string) =>
  body
    .split("\n\n")
    .map((b) => b.split("\n").find((l) => l.startsWith("data:")))
    .filter((l): l is string => Boolean(l))
    .map((l) => JSON.parse(l.slice(5)) as { type: string; [k: string]: unknown });

describe("HTTP API", async () => {
  const { runtime } = makeRuntime({ script: crmScript, searchFixtures: crmSearch });
  const app = await buildServer(runtime);
  afterAll(() => app.close());

  it("GET /api/health reports status and request id", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health", headers: { "x-request-id": "abc-123" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-request-id"]).toBe("abc-123");
    expect(res.json()).toMatchObject({ status: "ok", database: true, llm: { configured: true }, search: { configured: true } });
  });

  it("lists seeded conversations, clearly flagged", async () => {
    const res = await app.inject({ method: "GET", url: "/api/conversations" });
    const list = res.json().conversations as Array<{ title: string; seeded: boolean }>;
    expect(list.length).toBe(4);
    expect(list.every((c) => c.seeded && c.title.startsWith("[Demo]"))).toBe(true);
  });

  it("validates input", async () => {
    expect((await app.inject({ method: "POST", url: "/api/chat", payload: { message: "" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/chat", payload: { message: "hi", extra: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/chat", payload: { message: "hi", conversationId: "conv_doesnotexist" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/conversations/not-an-id" })).statusCode).toBe(400);
  });

  it("POST /api/chat streams SSE events end to end and persists the exchange", async () => {
    const res = await app.inject({ method: "POST", url: "/api/chat", payload: { message: crmMessage, timezone: "Europe/London" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const events = parseSse(res.body);
    const types = new Set(events.map((e) => e.type));
    for (const t of ["conversation", "stage", "memory", "search", "sources", "comparison", "token", "done"]) expect(types.has(t)).toBe(true);
    expect(types.has("error")).toBe(false);

    const convId = (events.find((e) => e.type === "conversation") as unknown as { conversationId: string }).conversationId;
    const conv = await app.inject({ method: "GET", url: `/api/conversations/${convId}` });
    const msgs = conv.json().messages as Array<{ role: string; metadata: { comparisons?: unknown[] } }>;
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[1]!.metadata.comparisons!.length).toBeGreaterThan(0);
  });

  it("streams a classified error event when the LLM is not configured", async () => {
    const { runtime: noLlm } = makeRuntime({ script: crmScript });
    (noLlm.agent as unknown as { deps: { llm: null } }).deps.llm = null;
    const app2 = await buildServer(noLlm);
    const res = await app2.inject({ method: "POST", url: "/api/chat", payload: { message: "hello" } });
    const err = parseSse(res.body).find((e) => e.type === "error") as unknown as { error: { code: string } };
    expect(err.error.code).toBe("NOT_CONFIGURED");
    await app2.close();
  });

  it("deletes conversations", async () => {
    const list = (await app.inject({ method: "GET", url: "/api/conversations" })).json().conversations as Array<{ id: string }>;
    const id = list[0]!.id;
    expect((await app.inject({ method: "DELETE", url: `/api/conversations/${id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/api/conversations/${id}` })).statusCode).toBe(404);
  });
});
