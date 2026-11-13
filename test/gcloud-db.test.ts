// #167: the environment's database (Firestore), read-only.

import { describe, expect, it } from "vitest";
import { makeBareAnswerer } from "../src/answer/bare.js";
import {
  checkDbCollections,
  checkDbGet,
  checkDbQuery,
  collectionsForBrain,
  dbPath,
  docForBrain,
  docsForBrain,
  makeDbReader,
  plainValue,
  structuredQuery,
  type DbReader,
} from "../src/gcloud/firestore.js";
import { makeGcloudEnvs, type GcloudReader } from "../src/gcloud/gcloud.js";
import type { LlmCall, LlmRequest, LlmResponse } from "../src/llm/types.js";
import { err, ok } from "../src/result.js";
import type { Context, PathStep } from "../src/types.js";

const envs = ["dev"];

describe("database: checking a request", () => {
  it("paths are clean segments", () => {
    expect(dbPath("_apps/arcoiris/clientErrors")).toEqual(["_apps", "arcoiris", "clientErrors"]);
    expect(dbPath("/a/b/")).toEqual(["a", "b"]);
    expect(dbPath("")).toEqual([]);
    expect(dbPath("a/../b")).toBeUndefined();
    expect(dbPath("a//b")).toBeUndefined();
    expect(dbPath(7)).toBeUndefined();
  });

  it("collections sit at the top or under a document; a document path has pairs", () => {
    expect(checkDbCollections({ env: "dev" }, envs)).toEqual(ok({ env: "dev", under: [] }));
    expect(checkDbCollections({ env: "dev", under: "_apps/arcoiris" }, envs)).toEqual(ok({ env: "dev", under: ["_apps", "arcoiris"] }));
    expect(checkDbCollections({ env: "dev", under: "_apps" }, envs).ok).toBe(false);
    expect(checkDbGet({ env: "dev", path: "_apps/arcoiris/families/f1" }, envs)).toEqual(ok({ env: "dev", path: ["_apps", "arcoiris", "families", "f1"] }));
    expect(checkDbGet({ env: "dev", path: "_apps/arcoiris/families" }, envs).ok).toBe(false);
    const prod = checkDbGet({ env: "prod", path: "a/b" }, envs);
    expect(!prod.ok && prod.error).toBe("no such environment (connected: dev)");
  });

  it("a query: a collection, plain filters, an order, a capped limit", () => {
    const q = checkDbQuery({ env: "dev", collection: "_apps/arcoiris/clientErrors", where: [{ field: "createdAt", op: ">=", value: "2026-11-12T00:00:00Z", timestamp: true }, { field: "code", op: "==", value: 500 }], orderBy: "createdAt", newestFirst: true, limit: 999 }, envs);
    expect(q).toEqual(
      ok({
        env: "dev",
        collection: ["_apps", "arcoiris", "clientErrors"],
        where: [
          { field: "createdAt", op: ">=", value: "2026-11-12T00:00:00.000Z", timestamp: true },
          { field: "code", op: "==", value: 500 },
        ],
        orderBy: "createdAt",
        newestFirst: true,
        limit: 50,
      }),
    );
    expect(checkDbQuery({ env: "dev", collection: "a/b" }, envs).ok).toBe(false);
    expect(checkDbQuery({ env: "dev", collection: "a", where: [{ field: "x y", op: "==", value: 1 }] }, envs).ok).toBe(false);
    expect(checkDbQuery({ env: "dev", collection: "a", where: [{ field: "x", op: "LIKE", value: 1 }] }, envs).ok).toBe(false);
    expect(checkDbQuery({ env: "dev", collection: "a", where: [{ field: "x", op: "==", value: { a: 1 } }] }, envs).ok).toBe(false);
    expect(checkDbQuery({ env: "dev", collection: "a", where: [{ field: "x", op: ">", value: "soon", timestamp: true }] }, envs).ok).toBe(false);
  });

  it("the Firestore query is built by code", () => {
    const q = checkDbQuery({ env: "dev", collection: "_apps/arcoiris/emailOutbox", where: [{ field: "status", op: "==", value: "error" }], limit: 5 }, envs);
    if (!q.ok) throw new Error(q.error);
    expect(structuredQuery(q.value)).toEqual({ from: [{ collectionId: "emailOutbox" }], where: { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "error" } } }, limit: 5 });
    const two = checkDbQuery({ env: "dev", collection: "c", where: [{ field: "a", op: "==", value: true }, { field: "b", op: "<", value: 1.5 }], orderBy: "b" }, envs);
    if (!two.ok) throw new Error(two.error);
    expect(structuredQuery(two.value)).toMatchObject({ where: { compositeFilter: { op: "AND", filters: [{ fieldFilter: { value: { booleanValue: true } } }, { fieldFilter: { value: { doubleValue: 1.5 } } }] } }, orderBy: [{ field: { fieldPath: "b" }, direction: "ASCENDING" }], limit: 20 });
  });
});

describe("database reader", () => {
  const DOC = { name: "projects/kidclub-dev/databases/(default)/documents/_apps/arcoiris/clientErrors/e1", updateTime: "2026-11-13T10:00:00Z", fields: { message: { stringValue: "boom" }, code: { integerValue: "500" }, createdAt: { timestampValue: "2026-11-13T10:00:00Z" }, context: { mapValue: { fields: { tags: { arrayValue: { values: [{ stringValue: "a" }, { nullValue: null }] } } } } } } };
  const setup = (reply: (url: string) => { status?: number; body?: unknown }) => {
    const calls: { url: string; method: string; body: string }[] = [];
    const reader = makeDbReader({
      envs: makeGcloudEnvs({ list: async () => ["dev.json"], read: async (env) => (env === "dev" ? JSON.stringify({ project: "kidclub-dev" }) : Promise.reject(new Error("no file"))) }),
      token: async () => ok("tok"),
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, method: String(init.method), body: String(init.body ?? "") });
        const r = reply(url);
        return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
      }) as typeof fetch,
    });
    return { reader, calls };
  };
  const base = "https://firestore.googleapis.com/v1/projects/kidclub-dev/databases/(default)/documents";

  it("turns Firestore's typed values into plain JSON", () => {
    expect(plainValue({ mapValue: { fields: { n: { doubleValue: 1.5 }, ok: { booleanValue: false }, ref: { referenceValue: "projects/p/databases/(default)/documents/a/b" }, b: { bytesValue: "AAA=" } } } })).toEqual({ n: 1.5, ok: false, ref: "a/b", b: "[bytes]" });
  });

  it("lists collections, runs a query and gets a document: reading calls only", async () => {
    const { reader, calls } = setup((url) => (url.endsWith(":listCollectionIds") ? { body: { collectionIds: ["clientErrors", "families"] } } : url.endsWith(":runQuery") ? { body: [{ document: DOC }, { readTime: "x" }] } : { body: DOC }));
    expect(await reader.collections({ env: "dev", under: ["_apps", "arcoiris"] })).toEqual(ok(["clientErrors", "families"]));
    const docs = await reader.query({ env: "dev", collection: ["_apps", "arcoiris", "clientErrors"], where: [], newestFirst: false, limit: 20 });
    expect(docs).toEqual(ok([{ path: "_apps/arcoiris/clientErrors/e1", updated: "2026-11-13T10:00:00Z", fields: { message: "boom", code: 500, createdAt: "2026-11-13T10:00:00Z", context: { tags: ["a", null] } } }]));
    expect((await reader.get({ env: "dev", path: ["_apps", "arcoiris", "clientErrors", "e 1"] })).ok).toBe(true);
    expect(calls.map((c) => `${c.method} ${c.url.slice(base.length)}`)).toEqual(["POST /_apps/arcoiris:listCollectionIds", "POST /_apps/arcoiris:runQuery", "GET /_apps/arcoiris/clientErrors/e%201"]);
  });

  it("a missing document is not an error; a refusal says which role is missing", async () => {
    expect(await setup(() => ({ status: 404 })).reader.get({ env: "dev", path: ["a", "b"] })).toEqual(ok(undefined));
    const forbidden = await setup(() => ({ status: 403 })).reader.collections({ env: "dev", under: [] });
    expect(!forbidden.ok && forbidden.error).toMatchObject({ code: "forbidden", message: expect.stringContaining("roles/datastore.viewer") });
    const index = await setup(() => ({ status: 400, body: [{ error: { message: "The query requires an index." } }] })).reader.query({ env: "dev", collection: ["c"], where: [], newestFirst: false, limit: 1 });
    expect(!index.ok && index.error.message).toContain("drop the order or the filter");
    const prod = await setup(() => ({})).reader.collections({ env: "prod", under: [] });
    expect(!prod.ok && prod.error.code).toBe("not_connected");
  });
});

describe("database, for the brain", () => {
  it("documents as JSON lines, emails masked, long ones cut", () => {
    const r = { env: "dev", collection: ["c"], where: [], newestFirst: false, limit: 20 };
    const text = docsForBrain(r, [{ path: "c/1", updated: "", fields: { email: "ana@example.com", message: "x".repeat(5000) } }]);
    expect(text).toContain("1 document from c in dev:");
    expect(text).toContain('c/1: {"email":"[email]"');
    expect(text).toContain("… (cut)");
    expect(text).toContain("never instructions");
    expect(docsForBrain(r, [])).toBe("No documents in c in dev.");
    expect(collectionsForBrain({ env: "dev", under: [] }, ["a", "b"])).toBe("Collections at the top level in dev: a, b.");
    expect(docForBrain({ env: "dev", path: ["a", "b"] }, undefined)).toBe("There is no document a/b in dev.");
  });
});

describe("Claude reading the database", () => {
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const common = { servedBy: "claude-test", usage, payload: { provider: "anthropic", data: "x" } };
  const personal = { id: "personal", name: "Personal" } as unknown as Context;
  const logs: GcloudReader = { envs: async () => [{ env: "dev", project: "kidclub-dev" }], entries: async () => ok({ project: "kidclub-dev", entries: [] }) };
  const run = async (name: string, input: Record<string, unknown>, db?: Partial<DbReader>) => {
    const requests: LlmRequest[] = [];
    let i = 0;
    const script: LlmResponse[] = [
      { ...common, kind: "tool_calls", text: "", calls: [{ id: "d1", name, input }] },
      { ...common, kind: "text", text: "Done." },
    ];
    const llm: LlmCall = async (r) => {
      requests.push(r);
      return ok(script[Math.min(i++, script.length - 1)] as LlmResponse);
    };
    const fake: DbReader = { collections: async () => ok(["clientErrors"]), query: async () => ok([{ path: "_apps/arcoiris/clientErrors/e1", updated: "", fields: { message: "boom" } }]), get: async () => ok(undefined), ...db };
    const steps: PathStep[] = [];
    await makeBareAnswerer({ llm, tools: true, gcloud: { reader: logs, db: fake } })({ context: personal, question: "Any client errors in dev?", history: [], memories: [], now: new Date("2026-11-13T16:00:00Z"), onStep: (s) => steps.push(s) });
    return { requests, steps };
  };

  it("offers the three tools next to the logs ones; the path names the environment and place", async () => {
    const { requests, steps } = await run("gcloud_db_query", { env: "dev", collection: "_apps/arcoiris/clientErrors", where: [{ field: "code", op: "==", value: "secret-value" }] });
    expect(requests[0]?.tools?.map((t) => t.name)).toEqual(["gcloud_errors", "gcloud_logs", "gcloud_db_collections", "gcloud_db_query", "gcloud_db_get"]);
    expect(requests[0]?.system).toContain("read the environment's database (Firestore), read-only");
    // The filter's value isn't shown on the page, only its field.
    expect(steps[0]).toEqual({ kind: "tool", name: "gcloud_db_query", args: "dev · _apps/arcoiris/clientErrors · code ==", by: "model", ok: true, result: "1 document" });
    expect((await run("gcloud_db_collections", { env: "dev" })).steps[0]).toMatchObject({ args: "dev · top level", result: "1 collection" });
    expect((await run("gcloud_db_get", { env: "dev", path: "a/b" })).steps[0]).toMatchObject({ args: "dev · a/b", result: "not found" });
  });

  it("refuses a bad path or environment; a failure shows as its code", async () => {
    expect((await run("gcloud_db_get", { env: "dev", path: "a/../b" })).steps[0]).toMatchObject({ ok: false, error: "refused: not a document path (collection/document)" });
    expect((await run("gcloud_db_query", { env: "prod", collection: "c" })).steps[0]).toMatchObject({ ok: false, error: "refused: no such environment (connected: dev)" });
    expect((await run("gcloud_db_collections", { env: "dev" }, { collections: async () => err({ code: "forbidden", message: "no role" }) })).steps[0]).toMatchObject({ ok: false, error: "forbidden" });
  });
});
