import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { parseContexts } from "../src/contexts.js";
import { makeJsonLogger } from "../src/log.js";
import { makeMemoryStoreInMemory, type MemoryStore } from "../src/memory-store.js";
import { makePrecheck } from "../src/precheck.js";
import { ok } from "../src/result.js";
import { localHosts, makeServer } from "../src/server.js";
import type { Context, ContextId, Deps } from "../src/types.js";

let contexts: readonly Context[] = [];
beforeAll(async () => {
  const parsed = parseContexts(await readFile("contexts.md", "utf8"));
  if (!parsed.ok) throw new Error(parsed.error);
  contexts = parsed.value;
});

const NOW = new Date("2026-11-07T10:00:00Z");
const SECRET_TEXT = "Inês's teacher is Ms Rita";

const setup = async () => {
  const lines: string[] = [];
  let t = NOW.getTime();
  let n = 0;
  const store = makeMemoryStoreInMemory({ now: () => new Date((t += 1000)), newId: () => `m${(n += 1)}` });
  const deps: Deps = {
    contexts,
    precheck: makePrecheck(contexts),
    classify: async () => ({ kind: "unclear" }),
    answer: async () => ok({ kind: "answer", text: "x" }),
    memory: { loadMemories: async () => [], wrapUp: async () => undefined },
    isAnswered: () => true,
    afterReply: () => undefined,
    now: () => NOW,
    log: makeJsonLogger({ write: (l) => lines.push(l), now: () => NOW }),
  };
  const app = makeServer(deps, { memories: store, allowedHosts: localHosts(8080) });
  const req = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method,
      headers: { host: "127.0.0.1:8080", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
  const add = (store_: MemoryStore, text: string, contextId = "personal", extra: object = {}) =>
    store_.add({ contextId: contextId as ContextId, kind: "fact", text, origin: "auto", source: "req-0", ...extra });
  const a = await add(store, SECRET_TEXT);
  const b = await add(store, "Monthly fees are due by the 8th", "kidclub", { kind: "playbook" });
  const h = await add(store, "Talked about Inês's school", "personal", { kind: "history", expiresAt: new Date("2026-12-07T10:00:00Z") });
  await store.markSeen([a.id]);
  return { app, req, store, lines, ids: { a: a.id, b: b.id, h: h.id } };
};

describe("GET /memories", () => {
  it("lists every memory newest first, with its context's name, dates and the unseen count", async () => {
    const { req } = await setup();
    const res = await req("GET", "/memories");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { memories: Record<string, unknown>[]; unseen: number; contexts: unknown[] };
    expect(body.memories.map((m) => m.id)).toEqual(["m3", "m2", "m1"]);
    expect(body.memories[1]).toEqual({
      id: "m2",
      contextId: "kidclub",
      contextName: "KidClub",
      kind: "playbook",
      text: "Monthly fees are due by the 8th",
      origin: "auto",
      createdAt: "2026-11-07T10:00:02.000Z",
      updatedAt: "2026-11-07T10:00:02.000Z",
      seen: false,
    });
    expect(body.memories[0]).toMatchObject({ kind: "history", expiresAt: "2026-12-07T10:00:00.000Z" });
    expect(body.unseen).toBe(2);
    // The contexts that can hold memories: never the EC/HRT handoff.
    expect(body.contexts).toEqual([
      { id: "personal", name: "Personal" },
      { id: "kidclub", name: "KidClub" },
      { id: "noisysource", name: "Noisy Source" },
    ]);
  });
});

describe("POST /memories/seen", () => {
  it("marks memories seen, clearing the badge", async () => {
    const { req, ids } = await setup();
    expect((await req("POST", "/memories/seen", { ids: [ids.b, ids.h] })).status).toBe(200);
    const body = (await (await req("GET", "/memories")).json()) as { unseen: number };
    expect(body.unseen).toBe(0);
  });

  it("rejects a bad body and non-JSON", async () => {
    const { req } = await setup();
    expect((await req("POST", "/memories/seen", { ids: "all" })).status).toBe(400);
    expect((await req("POST", "/memories/seen", { ids: ["../etc"] })).status).toBe(400);
    expect((await req("POST", "/memories/seen", "ids=m1", { "content-type": "application/x-www-form-urlencoded" })).status).toBe(415);
  });
});

describe("DELETE /memories/:id", () => {
  it("deletes one memory, and 404s for one that isn't there", async () => {
    const { req, store, ids } = await setup();
    const res = await req("DELETE", `/memories/${ids.a}`);
    expect(await res.json()).toEqual({ deleted: ids.a });
    expect(await store.get(ids.a)).toBeUndefined();
    expect((await req("DELETE", `/memories/${ids.a}`)).status).toBe(404);
    expect((await req("DELETE", "/memories/not%20an%20id")).status).toBe(400);
  });
});

describe("POST /memories/wipe", () => {
  it("wipes one context only", async () => {
    const { req, store } = await setup();
    expect(await (await req("POST", "/memories/wipe", { contextId: "personal" })).json()).toEqual({ wiped: 2, contextId: "personal" });
    expect((await store.list()).map((m) => m.contextId)).toEqual(["kidclub"]);
  });

  it("refuses unknown contexts, the EC/HRT handoff, bad bodies and non-JSON", async () => {
    const { req, store } = await setup();
    expect((await req("POST", "/memories/wipe", { contextId: "gmail" })).status).toBe(400);
    expect((await req("POST", "/memories/wipe", { contextId: "ec-hrt" })).status).toBe(400);
    expect((await req("POST", "/memories/wipe", {})).status).toBe(400);
    expect((await req("POST", "/memories/wipe", "{not json")).status).toBe(400);
    expect((await req("POST", "/memories/wipe", "contextId=personal", { "content-type": "text/plain" })).status).toBe(415);
    expect(await store.list()).toHaveLength(3);
  });
});

describe("guards and logs", () => {
  it("refuses other hosts (DNS-rebinding guard), like every route", async () => {
    const { req } = await setup();
    expect((await req("GET", "/memories", undefined, { host: "evil.example:8080" })).status).toBe(403);
    expect((await req("DELETE", "/memories/m1", undefined, { host: "evil.example:8080" })).status).toBe(403);
  });

  it("never logs memory text", async () => {
    const { req, lines, ids } = await setup();
    await req("GET", "/memories");
    await req("DELETE", `/memories/${ids.a}`);
    await req("POST", "/memories/wipe", { contextId: "kidclub" });
    const logged = lines.join("\n");
    expect(logged).not.toContain("Rita");
    expect(logged).not.toContain("fees");
    expect(logged).toContain('"message":"memories wiped"');
  });

  it("has no /memories routes without a store", async () => {
    const app = makeServer({ contexts, log: makeJsonLogger({ write: () => undefined }) } as unknown as Deps);
    expect((await app.request("/memories")).status).toBe(404);
  });
});
