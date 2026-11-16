import { describe, expect, it } from "vitest";
import { Budget } from "../src/safety/budget.js";
import { costUsd } from "../src/llm/pricing.js";

describe("Budget", () => {
  it("fires 80% and 100% alerts exactly once each", () => {
    const b = new Budget(10, 1);
    b.steps = 8;
    expect(b.takeAlerts().map((a) => a.percent)).toEqual([80]);
    expect(b.takeAlerts()).toEqual([]);
    b.steps = 10;
    expect(b.takeAlerts().map((a) => a.percent)).toEqual([100]);
    expect(b.stepsExceeded()).toBe(true);
  });

  it("tracks cost limit", () => {
    const b = new Budget(100, 0.5);
    b.addCost(0.3);
    expect(b.costExceeded()).toBe(false);
    b.addCost(0.25);
    expect(b.costExceeded()).toBe(true);
  });
});

describe("costUsd", () => {
  it("computes cost from usage and env prices", () => {
    expect(
      costUsd(
        { input_tokens: 1_000_000, output_tokens: 500_000 },
        { inPerM: 0.5, outPerM: 2 },
      ),
    ).toBeCloseTo(1.5);
  });
});
