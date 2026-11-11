// HTTP routes for skills (#116), used by the ✨ Skills panel and the approve card:
//
//   GET  /skills          every skill, drafts first
//   POST /skills/decide   { id, decision: "approve" | "delete" }
//
// Same guards as /memories: the Host allowlist, JSON-only POSTs, no-store.
// Logs carry outcomes, never skill text.

import type { Hono } from "hono";
import { z } from "zod";
import type { ServerEnv } from "./server.js";
import { skillsView, type SkillStore } from "./skills.js";
import type { Logger } from "./types.js";

const DecideBody = z.object({ id: z.string().regex(/^[a-f0-9]{8,64}$/), decision: z.enum(["approve", "delete"]) }).strict();

const errorBody = (message: string) => ({ type: "error" as const, message });
const isJson = (contentType: string | undefined): boolean => (contentType ?? "").split(";")[0]?.trim().toLowerCase() === "application/json";

export const registerSkillRoutes = (app: Hono<ServerEnv>, deps: { readonly store: SkillStore; readonly log: Logger }): void => {
  app.use("/skills", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });
  app.use("/skills/*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  app.get("/skills", async (c) => c.json({ skills: skillsView(await deps.store.list()) }));

  app.post("/skills/decide", async (c) => {
    if (!isJson(c.req.header("content-type"))) return c.json(errorBody("This needs Content-Type: application/json."), 415);
    const body = DecideBody.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return c.json(errorBody('Send { id, decision: "approve" | "delete" }.'), 400);
    if (body.data.decision === "delete") {
      const removed = await deps.store.remove(body.data.id);
      deps.log.info("skill deleted", { found: removed });
      return removed ? c.json({ ok: true, text: "Okay, that skill is gone." }) : c.json(errorBody("There's no skill with that id."), 404);
    }
    const skill = await deps.store.approve(body.data.id);
    deps.log.info("skill approved", { found: skill !== undefined });
    return skill
      ? c.json({ ok: true, text: `Approved: I'll follow “${skill.title}” from now on.`, tool: "skill_approved → active" })
      : c.json(errorBody("There's no skill with that id."), 404);
  });
};
