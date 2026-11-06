// Type-level tests: `npm run typecheck` checks these assertions. The runtime
// part shows the types are usable for building stub deps.
import { describe, expect, expectTypeOf, it } from "vitest";
import { ok } from "../src/result.js";
import type {
  AskResponse,
  Classification,
  Context,
  ContextId,
  Deps,
  Memory,
} from "../src/types.js";

const id = (s: string) => s as ContextId;

const personal: Context = {
  id: id("personal"),
  name: "Personal",
  description: "My own life.",
  data: "data/profile.md",
  tools: [],
  handling: { kind: "answer" },
};

const ecHrt: Context = {
  id: id("ec-hrt"),
  name: "European Commission / HRT",
  description: "Work for the European Commission / HRT itself.",
  data: "none (handled by Kiro)",
  tools: [],
  handling: {
    kind: "handoff",
    to: "Kiro (the EC's agent)",
    cues: ["European Commission", "HRT"],
    unless: [{ words: ["invoice"], routeTo: id("noisysource") }],
  },
};

describe("types", () => {
  it("ContextId is not a plain string", () => {
    expectTypeOf<ContextId>().toExtend<string>();
    expectTypeOf<string>().not.toExtend<ContextId>();
  });

  it("tools are a closed set", () => {
    // @ts-expect-error unknown tool names are rejected
    const bad: Context["tools"] = ["gmail"];
    expect(bad).toHaveLength(1);
  });

  it("handoff contexts must name a target", () => {
    expectTypeOf<Extract<Context["handling"], { kind: "handoff" }>["to"]>().toEqualTypeOf<string>();
    // @ts-expect-error handoff without `to`
    const bad: Context["handling"] = { kind: "handoff", cues: [], unless: [] };
    expect(bad.kind).toBe("handoff");
  });

  it("AskResponse narrows on type", () => {
    const describeResponse = (r: AskResponse): string => {
      switch (r.type) {
        case "answer":
          return `${r.context}: ${r.answer}`;
        case "clarify":
          return `${r.message} [${r.options.map((o) => o.name).join(", ")}]`;
        case "handoff":
          return `${r.context} -> ${r.to}: ${r.message}`;
        case "error":
          return r.message;
      }
    };

    expect(
      describeResponse({ type: "handoff", context: ecHrt.id, to: "Kiro", message: "This is for Kiro." }),
    ).toBe("ec-hrt -> Kiro: This is for Kiro.");
    expect(
      describeResponse({
        type: "clarify",
        message: "Which one?",
        options: [{ id: personal.id, name: personal.name }],
      }),
    ).toBe("Which one? [Personal]");
  });

  it("Classification is a context or unclear", () => {
    expectTypeOf<Classification["kind"]>().toEqualTypeOf<"context" | "unclear">();
  });

  it("Deps can be stubbed with plain functions", async () => {
    const memories: Memory[] = [];
    const deps: Deps = {
      contexts: [personal, ecHrt],
      precheck: () => ({ kind: "none" }),
      classify: async () => ({ kind: "context", contextId: personal.id }),
      answer: async ({ question }) => ok(`You asked: ${question}`),
      memory: {
        loadMemories: async () => memories,
        wrapUp: async () => undefined,
      },
      now: () => new Date("2026-11-06T12:00:00Z"),
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    };

    const classification = await deps.classify({ question: "Where do I live?", history: [] });
    expect(classification).toEqual({ kind: "context", contextId: "personal" });

    const answer = await deps.answer({
      context: personal,
      question: "Where do I live?",
      history: [],
      memories: [],
      now: deps.now(),
    });
    expect(answer).toEqual({ ok: true, value: "You asked: Where do I live?" });
  });
});
