import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// Guards the project rule "pure functions and types, no classes" so the lint
// config can't silently lose it.
const lintSnippet = async (code: string) => {
  const eslint = new ESLint({ cwd: process.cwd() });
  const [result] = await eslint.lintText(code, { filePath: "src/__snippet__.ts" });
  return (result?.messages ?? []).filter((m) => m.ruleId === "no-restricted-syntax");
};

describe("lint: no classes", () => {
  it("rejects class declarations", async () => {
    expect(await lintSnippet("export class Foo {}\n")).toHaveLength(1);
  });

  it("rejects class expressions", async () => {
    expect(await lintSnippet("export const Foo = class {};\n")).toHaveLength(1);
  });

  it("allows plain functions and types", async () => {
    const code = "export type T = { a: number };\nexport const f = (t: T): number => t.a;\n";
    expect(await lintSnippet(code)).toHaveLength(0);
  });
});
