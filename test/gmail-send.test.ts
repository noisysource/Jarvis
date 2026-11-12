// #120: Gmail drafts, and sending only after "Send it".

import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { barePrompt, makeBareAnswerer } from "../src/answer/bare.js";
import { buildDeps } from "../src/app.js";
import { handleAsk } from "../src/ask.js";
import { loadConfig } from "../src/config.js";
import { parseContexts } from "../src/contexts.js";
import type { GmailMessage, GmailReader } from "../src/gmail/gmail.js";
import { checkDraftRequest, makeGmailWriter, makePendingDrafts, rawMessage, type DraftRequest, type GmailWriter } from "../src/gmail/send.js";
import type { LlmCall, LlmRequest, LlmResponse } from "../src/llm/types.js";
import { makePrecheck } from "../src/precheck.js";
import { err, ok } from "../src/result.js";
import { makeServer } from "../src/server.js";
import type { Context, Deps, PathStep } from "../src/types.js";
import { confirmsOf } from "../src/web/chat.js";

const NOW = new Date("2026-11-11T19:30:00Z");
const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const common = { servedBy: "claude-test", usage, payload: { provider: "anthropic", data: null } };
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

let contexts: readonly Context[];
let isEc: (t: string) => boolean;
beforeAll(async () => {
  const parsed = parseContexts(await readFile("contexts.md", "utf8"));
  if (!parsed.ok) throw new Error("contexts.md didn't parse");
  contexts = parsed.value;
  const precheck = makePrecheck(parsed.value);
  isEc = (t) => precheck(t).kind === "handoff";
});

const late = { account: "personal", to: ["sam@example.com"], subject: "Running late", body: "Hi Sam,\n\nI'm running ten minutes late.\n\nRenato" };

describe("checking a draft", () => {
  it("accepts a normal email; refuses bad addresses, EC and empty parts", () => {
    expect(checkDraftRequest(late, isEc)).toEqual(ok({ ...late, cc: [] }));
    expect(checkDraftRequest({ ...late, to: ["not an address"] }, isEc)).toEqual(err("an address isn't a real email address"));
    expect(checkDraftRequest({ ...late, to: ["someone@ec.europa.eu"] }, isEc)).toEqual(err("EC email is for Kiro"));
    expect(checkDraftRequest({ ...late, subject: "UTP standup notes" }, isEc)).toEqual(err("EC email is for Kiro"));
    expect(checkDraftRequest({ ...late, to: [] }, isEc)).toEqual(err("no recipient"));
    expect(checkDraftRequest({ ...late, body: " " }, isEc)).toEqual(err("a body, not too long"));
    expect(checkDraftRequest({ ...late, account: "work" }, isEc)).toEqual(err("unknown account"));
  });

  it("builds a proper email, UTF-8 subjects and replies in the thread", () => {
    const d = checkDraftRequest({ ...late, subject: "Visita de estudo — inscrição" }, isEc);
    const raw = Buffer.from(rawMessage(d.ok ? d.value : (late as unknown as DraftRequest), { messageId: "<a@b>", references: "<z@b>" }), "base64url").toString("utf8");
    expect(raw).toContain("To: sam@example.com");
    expect(raw).toContain(`Subject: =?UTF-8?B?${Buffer.from("Visita de estudo — inscrição").toString("base64")}?=`);
    expect(raw).toContain("In-Reply-To: <a@b>");
    expect(raw).toContain("References: <z@b> <a@b>");
    expect(raw).toContain("Content-Type: text/plain; charset=UTF-8");
  });
});

describe("Gmail writes", () => {
  it("saves a draft, then sends it only when asked, and checks Gmail says SENT", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const writer = makeGmailWriter({
      accessToken: async () => ok("tok"),
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify(url.endsWith("/drafts") ? { id: "d1" } : { id: "m1", labelIds: ["SENT"] }));
      }) as unknown as typeof fetch,
    });
    const d = checkDraftRequest(late, isEc);
    expect(await writer.draft(d.ok ? d.value : (late as unknown as DraftRequest), { threadId: "t9", messageId: "<x@y>", references: "" })).toEqual(ok({ draftId: "d1" }));
    expect(calls[0]?.body).toMatchObject({ message: { threadId: "t9" } });
    expect(calls).toHaveLength(1);
    expect(await writer.send("personal", "d1")).toEqual(ok({ messageId: "m1" }));
    expect(calls[1]).toMatchObject({ url: expect.stringContaining("/drafts/send"), body: { id: "d1" } });
  });

  it("a read-only connection says how to fix it", async () => {
    const writer = makeGmailWriter({ accessToken: async () => ok("tok"), fetch: (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch });
    const r = await writer.send("noisysource", "d1");
    expect(!r.ok && r.error.message).toContain("GMAIL_WRITE=on npm run gmail:connect -- noisysource");
  });
});

const school: GmailMessage = { id: "18c0ffee01", date: "Tue", from: "Escola <e@escola.pt>", to: "r@example.com", cc: "", subject: "Visita", snippet: "x", unread: true };
const ecMail: GmailMessage = { ...school, id: "18c0ffee02", from: "x@ec.europa.eu", subject: "Sprint" };
const reader: GmailReader = {
  search: async () => ok([school, ecMail]),
  read: async (r) => ok({ ...(r.id === ecMail.id ? ecMail : school), body: "Text", thread: { threadId: "th1", messageId: "<m@escola.pt>", references: "" } }),
};
const scripted = (responses: readonly LlmResponse[]) => {
  const requests: LlmRequest[] = [];
  let i = 0;
  const llm: LlmCall = async (r) => {
    requests.push(r);
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return next ? ok(next) : err({ kind: "unknown", message: "no script", retryable: false });
  };
  return { llm, requests };
};
const fakeWriter = () => {
  const drafts: { d: DraftRequest; thread?: unknown }[] = [];
  const sent: string[] = [];
  const write: GmailWriter = {
    draft: async (d, thread) => {
      drafts.push({ d, thread });
      return ok({ draftId: `d${drafts.length}` });
    },
    send: async (_a, id) => {
      sent.push(id);
      return ok({ messageId: "m1" });
    },
  };
  return { write, drafts, sent };
};

describe("Claude drafts, Renato sends", () => {
  it("the prompt says drafts need his OK; without GMAIL_WRITE it can't send", () => {
    expect(barePrompt("Alex", { tools: true, email: true, emailDrafts: true })).toContain('only their \\"Send it\\" sends it'.replace(/\\/g, ""));
    expect(barePrompt("Alex", { tools: true, email: true })).toContain("You can't send, reply to, forward, delete or label email.");
  });

  it("a reply is drafted in the thread, with a Send it card; \"I've sent it\" is dropped", async () => {
    const w = fakeWriter();
    const { llm, requests } = scripted([
      { ...common, kind: "tool_calls", text: "", calls: [{ id: "t1", name: "gmail_draft", input: { ...late, to: ["e@escola.pt"], subject: "Re: Visita", reply_to_id: school.id } }] },
      { ...common, kind: "text", text: "I've sent it to the school. Anything else?" },
    ]);
    const bare = makeBareAnswerer({ llm, tools: true, gmail: { reader, isEc, writer: { write: w.write, pending: makePendingDrafts({ newId: () => "abcd1234" }) } } });
    expect(requests).toHaveLength(0);
    const deps = { contexts, precheck: makePrecheck(contexts), bare, nativeTools: true, log: silent, now: () => NOW } as unknown as Deps;
    const r = await handleAsk(deps, { question: "Reply to the school that Diniz will go", brain: "claude" });
    expect(requests[0]?.tools?.map((t) => t.name)).toContain("gmail_draft");
    expect(w.drafts[0]?.thread).toEqual({ threadId: "th1", messageId: "<m@escola.pt>", references: "" });
    expect(w.sent).toEqual([]); // nothing sent
    expect(r.type === "answer" ? confirmsOf(r.path ?? []) : []).toEqual([{ id: "abcd1234", label: "To e@escola.pt: “Re: Visita”", kind: "email" }]);
    expect(r.type === "answer" ? r.answer : "").not.toContain("I've sent it");
  });

  it("replying to EC email is refused", async () => {
    const w = fakeWriter();
    const { llm } = scripted([
      { ...common, kind: "tool_calls", text: "", calls: [{ id: "t1", name: "gmail_draft", input: { ...late, to: ["x@example.com"], subject: "Re: Sprint", reply_to_id: ecMail.id } }] },
      { ...common, kind: "text", text: "That's for Kiro." },
    ]);
    const steps: PathStep[] = [];
    await makeBareAnswerer({ llm, tools: true, gmail: { reader, isEc, writer: { write: w.write, pending: makePendingDrafts() } } })({
      context: contexts[0] as Context,
      question: "Reply to that",
      history: [],
      memories: [],
      now: NOW,
      onStep: (s) => steps.push(s),
    });
    expect(w.drafts).toEqual([]);
    expect(steps).toEqual([{ kind: "tool", name: "gmail_draft", args: "", by: "model", ok: false, error: "refused: EC email is for Kiro" }]);
  });

  it("end to end: Send it sends once and is worded by code; Keep as draft sends nothing", async () => {
    const w = fakeWriter();
    let round = 0;
    const claude: LlmCall = async () => {
      round += 1;
      return ok(round % 2 === 1 ? { ...common, kind: "tool_calls" as const, text: "", calls: [{ id: `t${round}`, name: "gmail_draft", input: late }] } : { ...common, kind: "text" as const, text: "Drafted; send it when you're ready." });
    };
    const config = loadConfig({ BARE_MODE: "on", GMAIL: "on", GMAIL_WRITE: "on" });
    if (!config.ok) throw new Error(config.error);
    const made = await buildDeps({
      config: config.value,
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      log: silent,
      profileFs: { readFile: async () => "Name: Alex", stat: async () => ({ mtimeMs: 1 }) } as never,
      makeLlm: () => ok(claude),
      gmailReader: reader,
      gmailWriter: w.write,
      now: () => NOW,
    });
    if (!made.ok) throw new Error(made.error);
    const app = makeServer(made.value);
    const cardOf = async () => {
      const r = await handleAsk(made.value, { question: "Tell Sam I'm running late", brain: "claude" });
      return r.type === "answer" ? confirmsOf(r.path ?? [])[0]?.id : undefined;
    };
    const send = async (id: string | undefined, decision: "yes" | "no") =>
      (await app.request("/gmail/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, decision }) })).json();
    const first = await cardOf();
    expect(await send(first, "yes")).toEqual({ ok: true, text: "Sent “Running late” to sam@example.com.", tool: "gmail_send personal → sent" });
    expect(await send(first, "yes")).toMatchObject({ ok: false }); // single use
    expect(w.sent).toEqual(["d1"]);
    const second = await cardOf();
    expect(await send(second, "no")).toEqual({ ok: true, text: "Okay, it stays in your personal Gmail Drafts." });
    expect(w.sent).toEqual(["d1"]);
  });

  it("config: GMAIL_WRITE=on needs GMAIL=on", () => {
    const bad = loadConfig({ BARE_MODE: "on", GMAIL_WRITE: "on" });
    expect(!bad.ok && bad.error).toContain("GMAIL_WRITE: needs GMAIL=on");
  });
});

describe("deleting a draft Jarvis wrote (#124)", () => {
  it("DELETE on the draft only; a missing draft and a read-only connection are said plainly", async () => {
    const calls: { url: string; method: string | undefined }[] = [];
    const writer = makeGmailWriter({
      accessToken: async () => ok("tok"),
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, method: init.method });
        return new Response(null, { status: url.endsWith("/gone") ? 404 : 204 });
      }) as unknown as typeof fetch,
    });
    expect(await writer.discard?.("personal", "d1")).toEqual(ok(undefined));
    expect(calls[0]).toEqual({ url: "https://gmail.googleapis.com/gmail/v1/users/me/drafts/d1", method: "DELETE" });
    const gone = await writer.discard?.("personal", "gone");
    expect(gone && !gone.ok && gone.error.message).toBe("That draft isn't in Gmail any more");
    const ro = makeGmailWriter({ accessToken: async () => ok("tok"), fetch: (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch });
    const refused = await ro.discard?.("noisysource", "d1");
    expect(refused && !refused.ok && refused.error.message).toContain("GMAIL_WRITE=on npm run gmail:connect -- noisysource");
  });

  it("end to end: the draft gets a ref; delete needs Delete it; Keep it deletes nothing; unknown refs are refused", async () => {
    const w = fakeWriter();
    const discarded: string[] = [];
    const write: GmailWriter = {
      ...w.write,
      discard: async (_a, id) => {
        discarded.push(id);
        return ok(undefined);
      },
    };
    let ref = "";
    const requests: LlmRequest[] = [];
    let script: LlmResponse[] = [];
    const claude: LlmCall = async (r) => {
      requests.push(r);
      const last = r.messages.at(-1);
      const toolText = JSON.stringify(last);
      const m = /draft ref ([a-f0-9]{8})/.exec(toolText);
      if (m?.[1]) ref = m[1];
      const next = script.shift();
      return ok(next ?? { ...common, kind: "text" as const, text: "Okay." });
    };
    const config = loadConfig({ BARE_MODE: "on", GMAIL: "on", GMAIL_WRITE: "on" });
    if (!config.ok) throw new Error(config.error);
    const made = await buildDeps({
      config: config.value,
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      log: silent,
      profileFs: { readFile: async () => "Name: Alex", stat: async () => ({ mtimeMs: 1 }) } as never,
      makeLlm: () => ok(claude),
      gmailReader: reader,
      gmailWriter: write,
      now: () => NOW,
    });
    if (!made.ok) throw new Error(made.error);
    const app = makeServer(made.value);
    const ask = async (question: string) => {
      const r = await handleAsk(made.value, { question, brain: "claude" });
      return r.type === "answer" ? (r.path ?? []) : [];
    };
    const decide = async (id: string | undefined, decision: "yes" | "no") =>
      (await app.request("/gmail/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, decision }) })).json();

    script = [{ ...common, kind: "tool_calls", text: "", calls: [{ id: "t1", name: "gmail_draft", input: late }] }];
    await ask("Tell Sam I'm running late");
    expect(ref).toMatch(/^[a-f0-9]{8}$/);
    expect(requests[0]?.tools?.map((t) => t.name)).toContain("gmail_draft_delete");

    script = [{ ...common, kind: "tool_calls", text: "", calls: [{ id: "t2", name: "gmail_draft_delete", input: { ref } }] }];
    const path = await ask("Actually, delete that draft");
    const card = confirmsOf(path)[0];
    expect(card).toMatchObject({ kind: "draft-delete", label: "To sam@example.com: “Running late”" });
    expect(discarded).toEqual([]); // nothing until his OK
    expect(await decide(card?.id, "no")).toEqual({ ok: true, text: "Okay, I kept the draft “Running late”." });
    expect(discarded).toEqual([]);

    script = [{ ...common, kind: "tool_calls", text: "", calls: [{ id: "t3", name: "gmail_draft_delete", input: { ref } }] }];
    const again = confirmsOf(await ask("No, really, delete it"))[0];
    expect(await decide(again?.id, "yes")).toEqual({ ok: true, text: "Deleted the draft “Running late”.", tool: "gmail_draft_delete personal → deleted" });
    expect(discarded).toEqual(["d1"]);
    expect(await decide(again?.id, "yes")).toMatchObject({ ok: false }); // single use

    // Once deleted, the ref is gone; a made-up one never reaches Gmail.
    script = [{ ...common, kind: "tool_calls", text: "", calls: [{ id: "t4", name: "gmail_draft_delete", input: { ref } }] }];
    const gone = await ask("Delete it again");
    expect(gone.find((s) => s.kind === "tool")).toMatchObject({ ok: false, error: "refused: unknown draft" });
    script = [{ ...common, kind: "tool_calls", text: "", calls: [{ id: "t5", name: "gmail_draft_delete", input: { ref: "zz" } }] }];
    expect((await ask("Delete draft zz")).find((s) => s.kind === "tool")).toMatchObject({ ok: false, error: "refused: not a draft ref" });
    expect(discarded).toEqual(["d1"]);
  });
});
