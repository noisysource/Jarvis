// Picks the answerer for a context. Contexts without one (in M0: kidclub and
// noisysource) get an `unavailable` outcome, "not connected yet", and no
// model call. That's a normal reply, not an error.

import { ok } from "../result.js";
import type { Context, Deps } from "../types.js";

export const notConnectedMessage = (context: Context): string =>
  `${context.name} isn't connected yet, so I can't answer that one.`;

export const makeAnswerRouter = (answerers: Readonly<Record<string, Deps["answer"]>>): Deps["answer"] =>
  async (input) => {
    const answerer = answerers[input.context.id];
    return answerer
      ? answerer(input)
      : ok({ kind: "unavailable", message: notConnectedMessage(input.context) });
  };
