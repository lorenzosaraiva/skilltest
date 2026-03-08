import { describe, expect, it } from "vitest";
import { renderJson } from "./json.js";

describe("renderJson", () => {
  it("returns valid JSON", () => {
    const output = renderJson({ status: "ok", count: 2 });

    expect(JSON.parse(output)).toEqual({ status: "ok", count: 2 });
  });

  it("does not emit literal ANSI escape codes", () => {
    const output = renderJson({ message: "\u001b[31mred\u001b[0m" });

    expect(output.includes("\u001b")).toBe(false);
    expect(JSON.parse(output)).toEqual({ message: "\u001b[31mred\u001b[0m" });
  });
});
