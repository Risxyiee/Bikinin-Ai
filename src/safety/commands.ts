// Command policy for run_command: block destructive patterns, allow a small allowlist,
// ask the user for everything else. Enforced in code, not only in the prompt.
export type Risk = "low" | "medium" | "high";

export type Verdict =
  | { decision: "allow" }
  | { decision: "confirm"; reason: string; risk: Risk; command: string }
  | { decision: "block"; reason: string; command: string };

const BLOCKED: Array<{ re: RegExp; reason: string }> = [
  {
    re: /\brm\s+(-\S+\s+)*(\/|~|\$HOME|\$\{HOME\})(\s|\/\*|$)/,
    reason: "rm pada root atau home",
  },
  { re: /(^|\s)\.\.(\/|\s|$)/, reason: "akses folder induk (..)" },
  { re: /(^|[\s>|])\/(?!dev\/null)/, reason: "path absolut di luar workspace" },
  { re: /(^|[\s>|])~/, reason: "path home (~) tidak diizinkan" },
  { re: /\$HOME|\$\{HOME\}/, reason: "referensi $HOME tidak diizinkan" },
  { re: /\bsudo\b/, reason: "sudo tidak diizinkan" },
  {
    re: /(^|[\s;&|])(git|gh|ssh|scp|rsync)(\s|$)/,
    reason: "git/gh/ssh tidak diizinkan dari agent",
  },
  { re: /\bnpm\s+publish\b/, reason: "npm publish tidak diizinkan" },
  { re: /\bmkfs/, reason: "format disk" },
  { re: /\bdd\s+if=/, reason: "dd tidak diizinkan" },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/, reason: "perintah sistem" },
  {
    re: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b/,
    reason: "pipe unduhan ke shell",
  },
  { re: /:\(\)\s*\{/, reason: "fork bomb" },
];

// Each shell segment (split on && || ; | newline) must match one of these to run without asking.
const ALLOWED: RegExp[] = [
  /^npm (run [\w:.-]+|test|ci|--version|-v)$/,
  /^npx (tsc|vitest|tsx|prettier)( .*)?$/,
  /^tsc( .*)?$/,
  /^node [\w./-]+\.(m?js|ts)$/,
  /^(ls|pwd|cat|head|tail|wc|grep|echo|mkdir)( .*)?$/,
];

export function classifyCommand(command: string): Verdict {
  const cmd = command.trim();
  if (cmd === "")
    return { decision: "block", reason: "perintah kosong", command };

  for (const rule of BLOCKED) {
    if (rule.re.test(cmd))
      return { decision: "block", reason: rule.reason, command };
  }

  const segments = cmd
    .split(/&&|\|\||;|\||\n/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const allSafe = segments.every((seg) => ALLOWED.some((re) => re.test(seg)));
  if (allSafe) return { decision: "allow" };

  return {
    decision: "confirm",
    reason: "perintah di luar allowlist",
    risk: "medium",
    command,
  };
}
