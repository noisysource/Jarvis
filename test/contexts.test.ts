import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  classifierContextIds,
  clarifyOptions,
  describeContexts,
  handoffMessage,
  loadContexts,
  parseContexts,
} from "../src/contexts.js";
import type { Context } from "../src/types.js";

const valid = `# Contexts
Anything before the first section is documentation.

## personal
Name: Personal
Description: My own life.
Data: data/profile.md
Tools: none

## noisysource
Name: Noisy Source
Description: The Noisy Source business, including invoicing the EC.
Data: None yet.
Tools: none

## ec-hrt
Name: European Commission / HRT
Description: EC work.
Data: None.
Tools: none
Handling: handoff
Handoff to: Kiro (the EC's agent)
Recognition cues: European Commission, EC
Unless: invoice, billing -> noisysource
`;

const parseOk = (md: string): readonly Context[] => {
  const result = parseContexts(md);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

const parseErr = (md: string): string => {
  const result = parseContexts(md);
  if (result.ok) throw new Error("expected a parse error");
  return result.error;
};

describe("parseContexts", () => {
  it("parses answer and handoff contexts", () => {
    const contexts = parseOk(valid);
    expect(contexts.map((c) => c.id)).toEqual(["personal", "noisysource", "ec-hrt"]);
    expect(contexts[0]).toMatchObject({ name: "Personal", tools: [], handling: { kind: "answer" } });
    expect(contexts[2]?.handling).toEqual({
      kind: "handoff",
      to: "Kiro (the EC's agent)",
      cues: ["European Commission", "EC"],
      unless: [{ words: ["invoice", "billing"], routeTo: "noisysource" }],
    });
  });

  it("parses optional aliases and passes them to clarify options", () => {
    const md = "## personal\nName: Personal\nDescription: d\nData: x\nTools: none\nAliases: pessoal, me\n\n## kidclub\nName: KidClub\nDescription: d\nData: x\nTools: none\n";
    const contexts = parseOk(md);
    expect(contexts[0]?.aliases).toEqual(["pessoal", "me"]);
    expect(contexts[1]).not.toHaveProperty("aliases");
    expect(clarifyOptions(contexts)).toEqual([
      { id: "personal", name: "Personal", aliases: ["pessoal", "me"] },
      { id: "kidclub", name: "KidClub" },
    ]);
  });

  it("parses a known tool", () => {
    const md = "## kidclub\nName: KidClub\nDescription: d\nData: Vendus\nTools: vendus\n";
    expect(parseOk(md)[0]?.tools).toEqual(["vendus"]);
  });

  it("parses the repo's real contexts.md", async () => {
    const contexts = parseOk(await readFile("contexts.md", "utf8"));
    expect(contexts.map((c) => c.id)).toEqual(["personal", "kidclub", "noisysource", "ec-hrt"]);
    const ec = contexts.find((c) => c.id === "ec-hrt");
    expect(ec?.handling.kind).toBe("handoff");
  });

  const base = "## a\nName: A\nDescription: d\nData: x\nTools: none\n";

  it.each([
    ["no contexts", "# just a title\n", "no contexts"],
    ["duplicate id", base + base, "duplicate context id"],
    ["bad id", "## Bad_Id\nName: A\nDescription: d\nData: x\nTools: none\n", "id must be lowercase"],
    ["missing field", "## a\nName: A\nData: x\nTools: none\n", 'missing "Description"'],
    ["missing tools", "## a\nName: A\nDescription: d\nData: x\n", 'missing "Tools"'],
    ["unknown key", base + "Colour: blue\n", 'unknown field "Colour"'],
    ["not key: value", base + "just some text\n", 'expected "Key: value"'],
    ["repeated key", base + "Name: Again\n", "appears more than once"],
    ["unknown tool", "## a\nName: A\nDescription: d\nData: x\nTools: gmail\n", "unknown tool(s) gmail"],
    ["bad handling", base + "Handling: maybe\n", '"Handling" must be'],
    ["handoff without target", base + "Handling: handoff\n", 'needs "Handoff to"'],
    [
      "handoff with tools",
      "## a\nName: A\nDescription: d\nData: x\nTools: vendus\nHandling: handoff\nHandoff to: Kiro\n",
      "can't have tools",
    ],
    ["cues on an answer context", base + "Recognition cues: EC\n", "only apply to handoff contexts"],
    ["handoff to on an answer context", base + "Handoff to: Kiro\n", "only applies to handoff contexts"],
    [
      "unless without cues",
      base + "Handling: handoff\nHandoff to: Kiro\nUnless: invoice -> a\n",
      'needs "Recognition cues"',
    ],
    [
      "malformed unless",
      base + "Handling: handoff\nHandoff to: Kiro\nRecognition cues: EC\nUnless: invoice\n",
      'must look like "word, word -> context-id"',
    ],
    [
      "unless to unknown context",
      base + "Handling: handoff\nHandoff to: Kiro\nRecognition cues: EC\nUnless: invoice -> nowhere\n",
      'unknown context "nowhere"',
    ],
    [
      "unless to a handoff context",
      base + "Handling: handoff\nHandoff to: Kiro\nRecognition cues: EC\nUnless: invoice -> a\n",
      "must point at an answered context",
    ],
  ])("rejects %s", (_label, md, expected) => {
    expect(parseErr(md)).toContain(expected);
  });

  it("reports every problem at once, naming the context", () => {
    const md = "## a\nName: A\nData: x\nTools: none\n\n## b\nName: B\nDescription: d\nData: x\nTools: gmail\n";
    const error = parseErr(md);
    expect(error).toContain('a (line 1): missing "Description"');
    expect(error).toContain("b (line 6): unknown tool(s) gmail");
  });
});

describe("loadContexts", () => {
  it("reads and parses", async () => {
    const result = await loadContexts(async () => valid, "contexts.md");
    expect(result.ok && result.value).toHaveLength(3);
  });

  it("names the file in errors", async () => {
    const result = await loadContexts(async () => "nothing", "contexts.md");
    expect(!result.ok && result.error).toContain("contexts.md is invalid");
  });

  it("handles a missing file", async () => {
    const result = await loadContexts(async () => {
      throw new Error("ENOENT");
    }, "contexts.md");
    expect(!result.ok && result.error).toBe("Couldn't read contexts.md: ENOENT");
  });
});

describe("helpers", () => {
  const contexts = parseOk(valid);
  const ec = contexts[2];

  it("classifier enum includes every context, handoff as a backstop", () => {
    expect(classifierContextIds(contexts)).toEqual(["personal", "noisysource", "ec-hrt"]);
  });

  it("describes contexts for the classifier prompt", () => {
    expect(describeContexts(contexts)).toBe(
      [
        "- personal (Personal): My own life.",
        "- noisysource (Noisy Source): The Noisy Source business, including invoicing the EC.",
        "- ec-hrt (European Commission / HRT): EC work.",
      ].join("\n"),
    );
  });

  it("never offers handoff contexts in a clarify response", () => {
    expect(clarifyOptions(contexts)).toEqual([
      { id: "personal", name: "Personal" },
      { id: "noisysource", name: "Noisy Source" },
    ]);
  });

  it("builds the handoff message", () => {
    expect(ec && handoffMessage(ec)).toBe(
      "This is for Kiro (the EC's agent). I don't handle European Commission / HRT requests.",
    );
  });
});
