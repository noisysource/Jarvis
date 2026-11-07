import { describe, expect, it } from "vitest";
import { makeMemoryStoreInMemory, matchScore, memoryWords } from "../src/memory-store.js";
import { describeMemoryStoreContract } from "./memory-store-contract.js";

let n = 0;
describeMemoryStoreContract("in-memory store", (clock) =>
  makeMemoryStoreInMemory({ now: clock.now, newId: () => `m${(n += 1)}` }),
);

describe("memoryWords", () => {
  it("folds accents and case, drops stop words and plural s", () => {
    expect(memoryWords("Who is Inês's teacher?")).toEqual(["ine", "teacher"]);
    expect(memoryWords("Quando é a natação da Inês?")).toEqual(["natacao", "ine"]);
    expect(memoryWords("swims SWIM")).toEqual(["swim", "swim"]);
  });

  it("counts distinct matching words", () => {
    expect(matchScore(memoryWords("teacher teacher Inês"), "Inês's teacher is Ms Rita")).toBe(2);
    expect(matchScore(memoryWords("coffee"), "Inês's teacher is Ms Rita")).toBe(0);
  });
});
