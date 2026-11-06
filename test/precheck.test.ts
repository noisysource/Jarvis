import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { parseContexts } from "../src/contexts.js";
import { makeCueMatcher, makePrecheck, type Precheck } from "../src/precheck.js";

// Runs against the real contexts.md, so editing the cues there is covered too.
let precheck: (question: string) => Precheck;

beforeAll(async () => {
  const parsed = parseContexts(await readFile("contexts.md", "utf8"));
  if (!parsed.ok) throw new Error(parsed.error);
  precheck = makePrecheck(parsed.value);
});

const outcome = (question: string): string => {
  const result = precheck(question);
  switch (result.kind) {
    case "handoff":
      return `handoff:${result.context.id}`;
    case "route":
      return `route:${result.contextId}`;
    case "none":
      return "none";
  }
};

describe("precheck with the real contexts.md", () => {
  it.each([
    // Invoicing words override the EC cues -> noisysource, no model.
    ["Invoice the European Commission for October", "route:noisysource"],
    ["Have I sent the European Commission invoice yet?", "route:noisysource"],
    ["Bill EPSO for the October workshop", "route:noisysource"],
    ["Prepara a fatura para a Comissão Europeia", "route:noisysource"],
    ["Faturação da Comissao Europeia de outubro", "route:noisysource"],
    ["When did I last bill the EC?", "route:noisysource"],
    // EC / HRT cues alone -> hand off to Kiro, no model.
    ["Summarise the HRT steering meeting", "handoff:ec-hrt"],
    ["What's on my European Commission agenda this week?", "handoff:ec-hrt"],
    ["Draft a reply to the EC about the new policy", "handoff:ec-hrt"],
    ["Ask Kiro about the deployment", "handoff:ec-hrt"],
    ["O que diz a Comissão Europeia sobre isto?", "handoff:ec-hrt"],
    ["Any news from EPSO on the competition?", "handoff:ec-hrt"],
    ["Check the CASP release notes", "handoff:ec-hrt"],
    ["What changed in Cast-p this sprint?", "handoff:ec-hrt"],
    ["what changed in cast p this sprint", "handoff:ec-hrt"],
    ["Is CastP down?", "handoff:ec-hrt"],
    ["Open the Recruiter Portal UTP ticket", "handoff:ec-hrt"],
    ["open the recruiter portal utp ticket", "handoff:ec-hrt"],
    ["Is UTP down again?", "handoff:ec-hrt"],
    ["Invoice UTP for the October work", "route:noisysource"],
    // No EC cue -> classifier decides.
    ["What's the commission on this sale?", "none"],
    ["Invoice the Commission for October", "none"],
    ["Send the KidClub invoices for October", "none"],
    ["What's my daughter's birthday?", "none"],
    ["Which invoices are unpaid?", "none"],
  ])("%s -> %s", (question, expected) => {
    expect(outcome(question)).toBe(expected);
  });

  it("doesn't match cues inside other words", () => {
    expect(outcome("I need an electric kettle recommendation")).toBe("none"); // "ec" inside a word
    expect(outcome("Check the HRTX build")).toBe("none");
  });

  it("matches acronyms case-sensitively", () => {
    expect(outcome("tell the ec about it")).toBe("none");
    expect(outcome("tell the EC about it")).toBe("handoff:ec-hrt");
    expect(outcome("casp")).toBe("none");
    expect(outcome("is utp down?")).toBe("none");
  });

  it("doesn't match new cues inside other words", () => {
    expect(outcome("The forecast predicts rain")).toBe("none"); // "cast" inside a word
    expect(outcome("Cast the vote")).toBe("none"); // "cast" alone is not "Cast-p"
  });
});

describe("makeCueMatcher", () => {
  it("ignores case for normal words and phrases", () => {
    expect(makeCueMatcher("the Commission")("email THE COMMISSION today")).toBe(true);
  });

  it("allows any whitespace inside a phrase", () => {
    expect(makeCueMatcher("European Commission")("European\n  Commission")).toBe(true);
  });

  it("ignores accents on both sides", () => {
    expect(makeCueMatcher("faturação")("faturacao")).toBe(true);
    expect(makeCueMatcher("faturacao")("faturação")).toBe(true);
  });

  it("lets a hyphen match a hyphen, whitespace or nothing", () => {
    const matches = makeCueMatcher("Cast-p");
    expect(["Cast-p", "Cast P", "CastP", "cast - p"].map(matches)).toEqual([true, true, true, true]);
    expect(matches("Castle")).toBe(false);
  });

  it("treats regex characters in cues literally", () => {
    expect(makeCueMatcher("C++")("I write C++ daily")).toBe(true);
    expect(makeCueMatcher("a.b")("axb")).toBe(false);
  });
});
