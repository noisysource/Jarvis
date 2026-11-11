// Gmail drafts and sending (#120), only with Renato's explicit OK.
//
// 1. Claude writes an email (or a reply in the same thread) with gmail_draft.
//    Code checks it (real addresses, sensible lengths, never EC: no europa.eu
//    recipients, no EC topics, no replies to EC email), and saves it in that
//    account's Gmail Drafts. Nothing is sent.
// 2. The page shows a card: To / Subject, with "Send it" / "Keep as draft".
// 3. Only "Send it" (POST /gmail/send) sends the draft, and the confirmation
//    is worded by code from Gmail's answer.
//
// Saving a draft doesn't count as "an action succeeded" for the honesty guard,
// so "I've sent it" from the model is always dropped. Logs carry counts and
// fixed words only: never addresses, subjects or text.

import { randomBytes } from "node:crypto";
import { err, ok, type Result } from "../result.js";
import type { LlmTool } from "../llm/types.js";
import type { CalendarError } from "../calendar/read.js";
import { GMAIL_ACCOUNTS, isGmailAccount, type GmailAccount } from "./gmail.js";

export const GMAIL_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";
const LIMITS = { recipients: 10, subject: 200, body: 10_000 } as const;

export const GMAIL_DRAFT_TOOL: LlmTool = {
  name: "gmail_draft",
  description:
    'Write an email as a draft in one of their Gmail accounts. Nothing is sent: the app shows them the draft and only their "Send it" sends it. To reply, give the id of the email you\'re answering (from gmail_search) and it goes in the same thread. account: "personal" or "noisysource".',
  inputSchema: {
    type: "object",
    properties: {
      account: { type: "string", enum: [...GMAIL_ACCOUNTS] },
      to: { type: "array", items: { type: "string" }, description: "Email addresses" },
      cc: { type: "array", items: { type: "string" } },
      subject: { type: "string" },
      body: { type: "string", description: "Plain text, in their voice, signed as they'd sign" },
      reply_to_id: { type: "string", description: "The id of the email this answers, from gmail_search; empty for a new email" },
    },
    required: ["account", "to", "subject", "body"],
    additionalProperties: false,
  },
};

export type DraftRequest = {
  readonly account: GmailAccount;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly subject: string;
  readonly body: string;
  readonly replyToId?: string;
};

const ADDRESS = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const EC_DOMAIN = /@(?:[a-z0-9-]+\.)*europa\.eu$/i;

const oneLine = (s: string, max: number): string =>
  [...s]
    .map((c) => (c.charCodeAt(0) < 32 ? " " : c))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max + 1);

/** Checks the brain's draft. `isEc`: the EC precheck, so EC mail is never written by Jarvis. */
export const checkDraftRequest = (value: unknown, isEc: (text: string) => boolean): Result<DraftRequest, string> => {
  if (typeof value !== "object" || value === null) return err("not understood");
  const v = value as Record<string, unknown>;
  if (!isGmailAccount(v.account)) return err("unknown account");
  const list = (x: unknown): string[] => (Array.isArray(x) ? x.map((a) => (typeof a === "string" ? a.trim() : "")).filter((a) => a !== "") : []);
  const to = list(v.to);
  const cc = list(v.cc);
  if (to.length === 0) return err("no recipient");
  if (to.length + cc.length > LIMITS.recipients) return err(`at most ${LIMITS.recipients} recipients`);
  if ([...to, ...cc].some((a) => !ADDRESS.test(a))) return err("an address isn't a real email address");
  if ([...to, ...cc].some((a) => EC_DOMAIN.test(a))) return err("EC email is for Kiro");
  const subject = typeof v.subject === "string" ? oneLine(v.subject, LIMITS.subject) : "";
  if (subject === "" || subject.length > LIMITS.subject) return err("a subject of one short line");
  const body = typeof v.body === "string" ? v.body.replace(/\r\n?/g, "\n").trim() : "";
  if (body === "" || body.length > LIMITS.body) return err("a body, not too long");
  if (isEc(`${subject}\n${body}`)) return err("EC email is for Kiro");
  const replyToId = typeof v.reply_to_id === "string" && v.reply_to_id.trim() !== "" ? v.reply_to_id.trim() : undefined;
  if (replyToId !== undefined && !/^[A-Za-z0-9_-]{6,64}$/.test(replyToId)) return err("not an email id");
  return ok({ account: v.account, to, cc, subject, body, ...(replyToId ? { replyToId } : {}) });
};

/** RFC 2047: a header value as UTF-8, when it isn't plain ASCII. */
const header = (value: string): string => (/^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`);

/** The email as Gmail's API wants it: RFC 2822, base64url. */
export const rawMessage = (d: DraftRequest, thread?: { readonly messageId: string; readonly references: string }): string => {
  const lines = [
    `To: ${d.to.join(", ")}`,
    ...(d.cc.length > 0 ? [`Cc: ${d.cc.join(", ")}`] : []),
    `Subject: ${header(d.subject)}`,
    ...(thread?.messageId ? [`In-Reply-To: ${thread.messageId}`, `References: ${[thread.references, thread.messageId].filter(Boolean).join(" ")}`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(d.body, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n"),
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
};

export type SavedDraft = { readonly draftId: string };
export type SentEmail = { readonly to: string; readonly subject: string };

export type GmailWriter = {
  /** Saves a draft (a reply goes in the original's thread). `original`: the email it answers, already checked. */
  readonly draft: (d: DraftRequest, original?: { readonly threadId: string; readonly messageId: string; readonly references: string }) => Promise<Result<SavedDraft, CalendarError>>;
  /** Sends a saved draft: only after his "Send it". */
  readonly send: (account: GmailAccount, draftId: string) => Promise<Result<{ readonly messageId: string }, CalendarError>>;
};

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export const makeGmailWriter = (deps: { readonly accessToken: (account: GmailAccount) => Promise<Result<string, CalendarError>>; readonly fetch?: typeof fetch }): GmailWriter => {
  const doFetch = deps.fetch ?? fetch;
  const post = async (account: GmailAccount, path: string, body: unknown): Promise<Result<unknown, CalendarError>> => {
    const token = await deps.accessToken(account);
    if (!token.ok) return token;
    let res: Response;
    try {
      res = await doFetch(`${API}${path}`, { method: "POST", headers: { authorization: `Bearer ${token.value}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
    } catch {
      return err({ code: "network", message: "Couldn't reach Gmail" });
    }
    if (res.status === 401 || res.status === 403)
      return err({ code: "auth", message: `Gmail refused (${res.status}): connect ${account} again with write access (GMAIL_WRITE=on npm run gmail:connect -- ${account}), then restart Jarvis` });
    if (!res.ok) return err({ code: "api", message: `Gmail answered ${res.status}` });
    return ok(await res.json().catch(() => ({})));
  };
  return {
    draft: async (d, original) => {
      const r = await post(d.account, "/drafts", { message: { raw: rawMessage(d, original), ...(original?.threadId ? { threadId: original.threadId } : {}) } });
      if (!r.ok) return r;
      const id = (r.value as { id?: unknown }).id;
      return typeof id === "string" ? ok({ draftId: id }) : err({ code: "api", message: "Gmail's answer had no draft id" });
    },
    send: async (account, draftId) => {
      const r = await post(account, "/drafts/send", { id: draftId });
      if (!r.ok) return r;
      const v = r.value as { id?: unknown; labelIds?: unknown };
      return typeof v.id === "string" && Array.isArray(v.labelIds) && v.labelIds.includes("SENT")
        ? ok({ messageId: v.id })
        : err({ code: "api", message: "Gmail didn't confirm it was sent" });
    },
  };
};

/** A saved draft waiting for "Send it": in memory, single use, 30 minutes. */
export type PendingDraft = { readonly account: GmailAccount; readonly draftId: string; readonly to: readonly string[]; readonly subject: string };

export const makePendingDrafts = (deps: { readonly now?: () => number; readonly ttlMs?: number; readonly newId?: () => string } = {}) => {
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? 30 * 60_000;
  const newId = deps.newId ?? (() => randomBytes(12).toString("hex"));
  const waiting = new Map<string, { readonly draft: PendingDraft; readonly until: number }>();
  const sweep = (): void => {
    for (const [id, w] of waiting) if (w.until <= now()) waiting.delete(id);
  };
  return {
    add: (draft: PendingDraft): string => {
      sweep();
      const id = newId();
      waiting.set(id, { draft, until: now() + ttl });
      return id;
    },
    take: (id: string): PendingDraft | undefined => {
      sweep();
      const w = waiting.get(id);
      waiting.delete(id);
      return w?.draft;
    },
  };
};
export type PendingDrafts = ReturnType<typeof makePendingDrafts>;

/** For the card: "To sam@example.com: “Running late”". */
export const draftLabel = (d: Pick<DraftRequest, "to" | "subject">): string => `To ${d.to.join(", ")}: “${d.subject}”`;
