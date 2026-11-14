// #8, #9: KidClub's invoices in Vendus, read-only.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makeBareAnswerer } from "../src/answer/bare.js";
import { groupsByWords } from "../src/answer/tool-groups.js";
import type { LlmCall, LlmRequest, LlmResponse } from "../src/llm/types.js";
import { ok } from "../src/result.js";
import type { Context, PathStep } from "../src/types.js";
import {
  allowedPath,
  cents,
  checkInvoicesRequest,
  invoiceForBrain,
  invoicesForBrain,
  listInvoices,
  makeVendusGet,
  type VendusGet,
} from "../src/vendus/vendus.js";
import { nodeOfTool } from "../src/web/brain-lib.js";

const KEY = "vendus-test-key-1234567890";

const fakeVendus = (reply: (url: string) => { status?: number; body: unknown }) => {
  const calls: { url: string; method: string; auth: string }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method), auth: String((init.headers as Record<string, string>).authorization) });
    const r = reply(url);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { calls, get: makeVendusGet({ apiKey: async () => KEY, fetch: fetchFn }) };
};

describe("the client: GET only, two paths", () => {
  it("allows the list and one document by numeric id, nothing else", () => {
    expect(allowedPath("/documents/")).toBe(true);
    expect(allowedPath("/documents/123/")).toBe(true);
    for (const p of ["/documents", "/documents/abc/", "/documents/1/pdf", "/clients/", "/documents/../clients/", "/documents/1/?x", "documents/"]) expect(allowedPath(p)).toBe(false);
  });

  it("refuses other paths and query fields before any network call", async () => {
    const { calls, get } = fakeVendus(() => ({ body: [] }));
    expect(await get("/clients/")).toMatchObject({ ok: false, error: { code: "refused" } });
    expect(await get("/documents/", { client_id: "1" })).toMatchObject({ ok: false, error: { code: "refused" } });
    expect(calls).toEqual([]);
  });

  it("sends the key as a Bearer token with GET, and never puts it in an error", async () => {
    const { calls, get } = fakeVendus(() => ({ status: 401, body: { errors: [{ code: "A002", message: "bad key" }] } }));
    const got = await get("/documents/", { since: "2026-11-01" });
    expect(calls[0]).toEqual({ url: "https://www.vendus.pt/ws/v1.1/documents/?since=2026-11-01", method: "GET", auth: `Bearer ${KEY}` });
    expect(got).toMatchObject({ ok: false, error: { code: "auth" } });
    expect(JSON.stringify(got)).not.toContain(KEY);
  });

  it("Vendus's 404 A001 is an empty list; no key is not connected", async () => {
    expect(await fakeVendus(() => ({ status: 404, body: { errors: [{ code: "A001", message: "No data" }] } })).get("/documents/")).toEqual(ok([]));
    expect(await fakeVendus(() => ({ status: 404, body: { errors: [{ code: "X" }] } })).get("/documents/9/")).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await makeVendusGet({ apiKey: async () => undefined })("/documents/")).toMatchObject({ ok: false, error: { code: "not_connected" } });
  });

  it("this module has no other HTTP method in it", () => {
    const source = readFileSync(new URL("../src/vendus/vendus.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"/);
    expect(source.match(/method:/g)).toHaveLength(1);
  });
});

describe("the period", () => {
  it("defaults to this month so far; checks dates and length", () => {
    expect(checkInvoicesRequest({}, "2026-11-14")).toEqual(ok({ since: "2026-11-01", until: "2026-11-14", type: "FR" }));
    expect(checkInvoicesRequest({ since: "2026-07-01", until: "2026-09-30", type: "all" }, "2026-11-14")).toEqual(ok({ since: "2026-07-01", until: "2026-09-30", type: "all" }));
    expect(checkInvoicesRequest({ since: "2026-02-30" }, "2026-11-14").ok).toBe(false);
    expect(checkInvoicesRequest({ since: "2026-11-10", until: "2026-11-01" }, "2026-11-14").ok).toBe(false);
    expect(checkInvoicesRequest({ since: "2024-01-01", until: "2026-11-01" }, "2026-11-14").ok).toBe(false);
  });
});

describe("listing and wording", () => {
  const doc = (id: number, date: string, gross: string, net: string, number = `FR 2026/${id}`) => ({ id, number, date, amount_gross: gross, amount_net: net });

  it("pages through the period and stops on a short page", async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => doc(i + 1, "2026-11-03", "10.00", "8.13"));
    const { calls, get } = fakeVendus((url) => ({ body: url.includes("page=1") ? page1 : [doc(51, "2026-11-04", "123.45", "100.37")] }));
    const got = await listInvoices(get, { since: "2026-11-01", until: "2026-11-14", type: "FR" });
    expect(got.ok && got.value.docs).toHaveLength(51);
    expect(got.ok && got.value.capped).toBe(false);
    expect(calls.map((c) => c.url)).toEqual([
      "https://www.vendus.pt/ws/v1.1/documents/?since=2026-11-01&until=2026-11-14&type=FR&per_page=50&page=1",
      "https://www.vendus.pt/ws/v1.1/documents/?since=2026-11-01&until=2026-11-14&type=FR&per_page=50&page=2",
    ]);
  });

  it("totals with and without VAT, by month, credit notes subtracted", () => {
    expect(cents("123.45")).toBe(12345);
    expect(cents("x")).toBe(0);
    const docs = [
      { id: 1, number: "FR 2026/1", date: "2026-10-05", type: "FR", grossCents: 12300, netCents: 10000 },
      { id: 2, number: "FR 2026/2", date: "2026-11-02", type: "FR", grossCents: 6150, netCents: 5000 },
      { id: 3, number: "NC 2026/1", date: "2026-11-03", type: "NC", grossCents: 1230, netCents: 1000 },
    ];
    const text = invoicesForBrain({ since: "2026-10-01", until: "2026-11-14", type: "all" }, docs, false);
    expect(text).toContain("Documents dated 2026-10-01 to 2026-11-14: 3. Total €172.20 with VAT, €140.00 without, VAT €32.20.");
    expect(text).toContain("By month: 2026-10 1 for €123.00 (€100.00 net); 2026-11 2 for €49.20 (€40.00 net).");
    expect(text).toContain("By type: FR 2, NC 1.");
    expect(invoicesForBrain({ since: "2026-11-01", until: "2026-11-14", type: "FR" }, [], false)).toBe("No FR documents dated 2026-11-01 to 2026-11-14 in Vendus.");
  });

  it("one invoice: client name, VAT by rate and lines; no fiscal number or email", () => {
    const text = invoiceForBrain({
      id: 7,
      number: "FR 2026/7",
      date: "2026-11-02",
      amount_gross: "61.50",
      amount_net: "50.00",
      client: { name: "Família Exemplo", fiscal_id: "123456789", email: "ana@example.com" },
      taxes: [{ rate: 23, base: "50.00", amount: "11.50" }],
      items: [{ title: "Sala de estudo", qty: 1, amount_gross: "61.50" }],
    });
    expect(text).toContain("FR 2026/7 (id 7), 2026-11-02: €61.50 with VAT, €50.00 without.");
    expect(text).toContain("Client: Família Exemplo.");
    expect(text).toContain("VAT: 23% on €50.00 = €11.50.");
    expect(text).toContain("Lines: Sala de estudo × 1 €61.50.");
    expect(text).not.toMatch(/123456789|ana@example/);
    expect(invoiceForBrain({ id: 8, number: "FR 2026/8", date: "2026-11-02", client: null })).toContain("Client: Consumidor final.");
  });
});

describe("asking Jarvis", () => {
  it('"how much did we invoice this month?" reaches Vendus, read-only, with counts on the path', async () => {
    expect(groupsByWords("How much did we invoice this month?")).toContain("invoices");
    expect(groupsByWords("Quanto faturámos em outubro?")).toContain("invoices");
    expect(nodeOfTool("vendus_invoices")).toBe("vendus");
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const common = { servedBy: "claude-test", usage, payload: { provider: "anthropic", data: "x" } };
    const script: LlmResponse[] = [
      { ...common, kind: "tool_calls", text: "", calls: [{ id: "v1", name: "vendus_invoices", input: {} }] },
      { ...common, kind: "text", text: "€61.50 so far this month." },
    ];
    const requests: LlmRequest[] = [];
    let i = 0;
    const llm: LlmCall = async (r) => {
      requests.push(r);
      return ok(script[Math.min(i++, script.length - 1)] as LlmResponse);
    };
    const asked: string[] = [];
    const get: VendusGet = async (path, query) => {
      asked.push(`${path} ${JSON.stringify(query)}`);
      return ok([{ id: 7, number: "FR 2026/7", date: "2026-11-02", amount_gross: "61.50", amount_net: "50.00" }]);
    };
    const steps: PathStep[] = [];
    await makeBareAnswerer({ llm, tools: true, vendus: { get, timeZone: "Europe/Lisbon" }, route: { mode: "rules" } })({
      context: { id: "kidclub", name: "KidClub" } as unknown as Context,
      question: "How much did we invoice this month?",
      history: [],
      memories: [],
      now: new Date("2026-11-14T10:00:00Z"),
      onStep: (s) => steps.push(s),
    });
    expect(requests[0]?.tools?.map((t) => t.name)).toEqual(["vendus_invoices", "vendus_invoice"]);
    expect(requests[0]?.system).toContain("KidClub's invoices in Vendus, read-only");
    expect(asked).toEqual(['/documents/ {"since":"2026-11-01","until":"2026-11-14","type":"FR","per_page":"50","page":"1"}']);
    expect(steps[0]).toEqual({ kind: "tool", name: "vendus_invoices", args: "2026-11-01 → 2026-11-14", by: "model", ok: true, result: "1 document" });
    expect(JSON.stringify(requests[1]?.messages)).toContain("Total €61.50 with VAT, €50.00 without");
  });
});
