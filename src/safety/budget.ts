// Step and cost budget. Emits 80% and 100% alerts exactly once each.
export interface BudgetAlert {
  kind: "steps" | "cost";
  used: number;
  limit: number;
  percent: 80 | 100;
}

export class Budget {
  steps = 0;
  costUsd = 0;
  private readonly fired = new Set<string>();

  constructor(
    readonly maxSteps: number,
    readonly maxCostUsd: number,
  ) {}

  addCost(usd: number): void {
    this.costUsd += usd;
  }

  stepsExceeded(): boolean {
    return this.steps >= this.maxSteps;
  }

  costExceeded(): boolean {
    return this.costUsd >= this.maxCostUsd;
  }

  takeAlerts(): BudgetAlert[] {
    const alerts: BudgetAlert[] = [];
    const checks: Array<{
      kind: "steps" | "cost";
      used: number;
      limit: number;
    }> = [
      { kind: "steps", used: this.steps, limit: this.maxSteps },
      { kind: "cost", used: this.costUsd, limit: this.maxCostUsd },
    ];
    for (const c of checks) {
      const pct = c.limit > 0 ? (c.used / c.limit) * 100 : 100;
      for (const percent of [80, 100] as const) {
        const key = `${c.kind}:${percent}`;
        if (pct >= percent && !this.fired.has(key)) {
          this.fired.add(key);
          alerts.push({ ...c, percent });
        }
      }
    }
    return alerts;
  }
}
