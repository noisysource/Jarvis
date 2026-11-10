// Validates the body of POST /ask. The server stores nothing: the page sends
// the conversation so far with each question.

import { z } from "zod";
import { err, ok, type Result } from "./result.js";
import type { AskRequest, ContextId } from "./types.js";

export const LIMITS = {
  questionChars: 2_000,
  historyTurns: 20,
  turnChars: 4_000,
  toolsPerTurn: 5,
  toolChars: 80,
} as const;

const AskRequestSchema = z
  .object({
    question: z
      .string({ error: "question must be text" })
      .trim()
      .min(1, { error: "question is empty" })
      .max(LIMITS.questionChars, { error: `question is longer than ${LIMITS.questionChars} characters` }),
    // Checked against contexts.md by the ask handler; here only the shape.
    context: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/, { error: "context must be a context id" })
      .optional(),
    history: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"], { error: 'history role must be "user" or "assistant"' }),
            text: z
              .string()
              .min(1, { error: "history text is empty" })
              .max(LIMITS.turnChars, { error: `a history turn is longer than ${LIMITS.turnChars} characters` }),
            // The tool calls that really ran for that answer (#104), as the page's path line shows them.
            tools: z
              .array(z.string().min(1).max(LIMITS.toolChars, { error: `a tool entry is longer than ${LIMITS.toolChars} characters` }), { error: "tools must be a list" })
              .max(LIMITS.toolsPerTurn, { error: `more than ${LIMITS.toolsPerTurn} tools on a turn` })
              .optional(),
          })
          .strict(),
        { error: "history must be a list of turns" },
      )
      .max(LIMITS.historyTurns, { error: `history has more than ${LIMITS.historyTurns} turns` })
      .optional(),
    conversationId: z
      .string()
      .regex(/^[A-Za-z0-9-]{8,64}$/, { error: "conversationId must be 8 to 64 letters, digits or hyphens" })
      .optional(),
    remember: z.boolean({ error: "remember must be true or false" }).optional(),
    // Voice (#76): a spoken turn (tuned for speed), and the context the spoken conversation was last answered in.
    spoken: z.boolean({ error: "spoken must be true or false" }).optional(),
    stickyContext: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/, { error: "stickyContext must be a context id" })
      .optional(),
    // Only the two configured brains (#88); never a model name.
    brain: z.enum(["claude", "local"], { error: 'brain must be "claude" or "local"' }).optional(),
  })
  .strict();

/** Every problem in one string, e.g. "question: question is empty". */
export const parseAskRequest = (body: unknown): Result<AskRequest, string> => {
  const parsed = AskRequestSchema.safeParse(body);
  if (!parsed.success) {
    return err(
      parsed.error.issues
        .map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
        .join("; "),
    );
  }
  const { question, context, history, conversationId, remember, spoken, stickyContext, brain } = parsed.data;
  return ok({
    question,
    ...(context !== undefined ? { context: context as ContextId } : {}),
    ...(history !== undefined ? { history } : {}),
    ...(conversationId !== undefined ? { conversationId } : {}),
    ...(remember !== undefined ? { remember } : {}),
    ...(spoken !== undefined ? { spoken } : {}),
    ...(stickyContext !== undefined ? { stickyContext: stickyContext as ContextId } : {}),
    ...(brain !== undefined ? { brain } : {}),
  });
};
