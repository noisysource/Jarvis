// HTTP routes for reviewing memories (#62), used by the Memories panel:
//
//   GET    /memories            every memory, newest first, plus the unseen count
//   DELETE /memories/:id        delete one (404 if there's no such memory)
//   POST   /memories/wipe       { contextId }: delete all of a context's memories
//   POST   /memories/seen       { ids }: mark memories as seen (clears the badge)
//
// They sit behind the same guards as /ask: the Host allowlist, and JSON-only
// POSTs (a cross-site page can't send JSON or DELETE without a CORS
// preflight, which this server never answers). Responses are never cached.
// Logs carry counts and outcomes, never memory text.

import type { Context as HonoContext, Hono } from "hono";
import { z } from "zod";
import type { MemoryStore } from "./memory-store.js";
import type { ServerEnv } from "./server.js";
import type { Context, Logger, Memory } from "./types.js";

/** What the page gets for each memory. Dates as ISO strings. */
export type MemoryView = {
  readonly id: string;
  readonly contextId: string;
  readonly contextName: string;
  readonly kind: Memory["kind"];
  readonly text: string;
  readonly origin: Memory["origin"];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt?: string;
  readonly seen: boolean;
};

export const toMemoryView = (m: Memory, contexts: readonly Context[]): MemoryView => ({
  id: m.id,
  contextId: m.contextId,
  contextName: contexts.find((c) => c.id === m.contextId)?.name ?? m.contextId,
  kind: m.kind,
  text: m.text,
  origin: m.origin,
  createdAt: m.createdAt.toISOString(),
  updatedAt: m.updatedAt.toISOString(),
  ...(m.expiresAt ? { expiresAt: m.expiresAt.toISOString() } : {}),
  seen: m.seen,
});

const MEMORY_ID = /^[A-Za-z0-9-]{1,100}$/;
const WipeBody = z.object({ contextId: z.string().min(1).max(64) }).strict();
const SeenBody = z.object({ ids: z.array(z.string().regex(MEMORY_ID)).max(1000) }).strict();

const errorBody = (message: string) => ({ type: "error" as const, message });

const isJson = (contentType: string | undefined): boolean =>
  (contentType ?? "").split(";")[0]?.trim().toLowerCase() === "application/json";

export const registerMemoryRoutes = (
  app: Hono<ServerEnv>,
  deps: { readonly store: MemoryStore; readonly contexts: readonly Context[]; readonly log: Logger },
): void => {
  const noStore = async (c: HonoContext<ServerEnv>, next: () => Promise<void>) => {
    await next();
    c.header("Cache-Control", "no-store");
  };
  const jsonOnly = async (c: HonoContext<ServerEnv>, next: () => Promise<void>) => {
    if (!isJson(c.req.header("content-type"))) {
      deps.log.warn("rejected request", { requestId: c.get("requestId"), reason: "not_json" });
      return c.json(errorBody("This needs Content-Type: application/json."), 415);
    }
    await next();
  };
  const readJson = async (c: HonoContext<ServerEnv>): Promise<unknown> => {
    try {
      return await c.req.json();
    } catch {
      return undefined;
    }
  };
  /** Contexts that can hold memories: the answered kind, never a handoff (EC/HRT). */
  const memoryContexts = deps.contexts.filter((c) => c.handling.kind === "answer");

  app.use("/memories", noStore);
  app.use("/memories/*", noStore);

  app.get("/memories", async (c) => {
    const memories = (await deps.store.list()).map((m) => toMemoryView(m, deps.contexts));
    deps.log.info("memories listed", { requestId: c.get("requestId"), count: memories.length });
    return c.json({
      memories,
      unseen: memories.filter((m) => !m.seen).length,
      contexts: memoryContexts.map((ctx) => ({ id: ctx.id, name: ctx.name })),
    });
  });

  app.post("/memories/seen", jsonOnly, async (c) => {
    const body = SeenBody.safeParse(await readJson(c));
    if (!body.success) return c.json(errorBody("Send { ids: [...] } with memory ids."), 400);
    await deps.store.markSeen(body.data.ids);
    return c.json({ seen: body.data.ids.length });
  });

  app.post("/memories/wipe", jsonOnly, async (c) => {
    const body = WipeBody.safeParse(await readJson(c));
    const context = body.success ? memoryContexts.find((ctx) => ctx.id === body.data.contextId) : undefined;
    if (!context) return c.json(errorBody("Send { contextId } with one of your contexts."), 400);
    const removed = await deps.store.wipe({ contextId: context.id });
    deps.log.info("memories wiped", { requestId: c.get("requestId"), contextId: context.id, count: removed });
    return c.json({ wiped: removed, contextId: context.id });
  });

  app.delete("/memories/:id", async (c) => {
    const id = c.req.param("id");
    if (!MEMORY_ID.test(id)) return c.json(errorBody("That isn't a memory id."), 400);
    const deleted = await deps.store.delete(id);
    deps.log.info("memory deleted", { requestId: c.get("requestId"), found: deleted });
    return deleted ? c.json({ deleted: id }) : c.json(errorBody("There's no memory with that id."), 404);
  });
};
