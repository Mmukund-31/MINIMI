/** Importing past conversations with original timestamps, and recalling them by date. */
import { afterAll, describe, expect, it } from "vitest";
import { importConversation } from "@minimi/core";
import { buildServer } from "../../apps/api/src/server";
import { analysis } from "../../evals/fixtures/scenario-kit";
import { eventsOf, makeRuntime, runTurn } from "../helpers";

// FIXED_NOW is Sunday 15 November 2026 (Europe/London); 10 November is the previous Tuesday.
const nodeChat = {
  title: "Node.js version for a new API",
  timezone: "Europe/London",
  messages: [
    { role: "user", content: "Which Node.js version should we use for a new backend API?", createdAt: "2026-11-10T10:15:00Z" },
    { role: "assistant", content: "Use Node.js 24, the current Active LTS line.", createdAt: "2026-11-10T10:15:20Z" },
  ],
};

describe("importConversation (core)", () => {
  const { runtime } = makeRuntime({ script: { structured: {}, synthesis: "" }, seed: false });
  const opts = { defaultTimezone: "Europe/London", now: new Date("2026-11-15T12:00:00Z") };

  it("stores messages with their original timestamps and flags them as imported", () => {
    const conv = importConversation(runtime.repos, runtime.db, nodeChat, opts);
    const msgs = runtime.repos.messages.listByConversation(conv.id);
    expect(msgs.map((m) => m.createdAt)).toEqual(["2026-11-10T10:15:00.000Z", "2026-11-10T10:15:20.000Z"]);
    expect(conv.metadata.imported).toBe(true);
    expect(msgs.every((m) => m.metadata.imported)).toBe(true);
    // Indexed for full-text recall by the same triggers as live messages.
    expect(runtime.repos.messages.search('"node"').length).toBeGreaterThan(0);
  });

  it("rejects future timestamps, out-of-order messages and unknown fields", () => {
    const future = { messages: [{ role: "user", content: "hi", createdAt: "2027-01-01T00:00:00Z" }] };
    const unordered = { messages: [nodeChat.messages[1], nodeChat.messages[0]] };
    const extra = { ...nodeChat, admin: true };
    expect(() => importConversation(runtime.repos, runtime.db, future, opts)).toThrow(/future/);
    expect(() => importConversation(runtime.repos, runtime.db, unordered, opts)).toThrow(/chronological/);
    expect(() => importConversation(runtime.repos, runtime.db, extra, opts)).toThrow(/Invalid import/);
    expect(() => importConversation(runtime.repos, runtime.db, { messages: [] }, opts)).toThrow(/Invalid import/);
  });
});

describe("POST /api/conversations/import", async () => {
  const { runtime } = makeRuntime({ script: { structured: {}, synthesis: "" }, seed: false });
  const app = await buildServer(runtime);
  afterAll(() => app.close());

  it("creates the conversation and lists it as imported", async () => {
    const res = await app.inject({ method: "POST", url: "/api/conversations/import", payload: nodeChat });
    expect(res.statusCode).toBe(201);
    expect(res.json().messageCount).toBe(2);
    const list = (await app.inject({ method: "GET", url: "/api/conversations" })).json().conversations as Array<{ title: string; imported: boolean }>;
    expect(list.find((c) => c.title === nodeChat.title)?.imported).toBe(true);
  });

  it("returns 400 with the failing field for invalid payloads", async () => {
    const res = await app.inject({ method: "POST", url: "/api/conversations/import", payload: { messages: [{ role: "system", content: "x", createdAt: "2026-11-10T10:00:00Z" }] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("messages.0.role");
  });
});

describe("An imported conversation is recalled by date", async () => {
  const { runtime } = makeRuntime({
    script: {
      structured: { message_analysis: analysis({ intent: "memory_recall", needsMemory: true, needsWebSearch: false, temporalExpressions: ["last Tuesday"] }) },
      synthesis: (req) => (req.messages[0]!.content.includes("Node.js 24") ? "On Tuesday you asked which Node.js version to use; I said Node.js 24." : "I couldn't find it."),
    },
    seed: false,
  });
  importConversation(runtime.repos, runtime.db, nodeChat, { defaultTimezone: "Europe/London", now: new Date("2026-11-15T12:00:00Z") });
  const { events, result, error } = await runTurn(runtime, "What did I ask you last Tuesday?");

  it("finds the imported exchange from the date phrase", () => {
    expect(error).toBeUndefined();
    const mem = eventsOf(events, "memory")[0]!;
    expect(mem.summary.status).toBe("found");
    expect(mem.exchanges[0]!.conversationTitle).toBe(nodeChat.title);
    expect(mem.summary.seeded).toBe(false);
    expect(result!.content).toContain("Node.js 24");
  });
});
