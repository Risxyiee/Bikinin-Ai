// Cost is computed from provider usage x env prices, never from provider cost fields.
// Cached tokens are billed at the full input price here (conservative estimate).
export interface Prices {
  inPerM: number;
  outPerM: number;
}

export function costUsd(
  usage: { input_tokens: number; output_tokens: number },
  p: Prices,
): number {
  return (
    (usage.input_tokens * p.inPerM + usage.output_tokens * p.outPerM) /
    1_000_000
  );
}
