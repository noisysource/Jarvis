import { describe, expect, it } from "vitest";
import { SERVICE_NAME } from "../src/index.js";

describe("scaffold", () => {
  it("exports the service name", () => {
    expect(SERVICE_NAME).toBe("jarvis");
  });
});
