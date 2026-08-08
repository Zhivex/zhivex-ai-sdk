import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

export interface SecretFinding {
  file: string;
  line: number;
  rule: string;
}

const rules = [
  { name: "private-key", pattern: /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/ },
  { name: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { name: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { name: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { name: "provider-secret", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ }
] as const;

const sensitiveTrackedFile = /(?:^|\/)(?:\.env(?:\..+)?|\.npmrc)$/i;

export const scanTextForSecrets = (file: string, text: string): SecretFinding[] => {
  const findings: SecretFinding[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    for (const rule of rules) {
      if (rule.pattern.test(line)) {
        findings.push({ file, line: index + 1, rule: rule.name });
      }
    }
  }
  return findings;
};

export const scanTrackedFiles = (repoRoot = process.cwd()): SecretFinding[] => {
  const output = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  const findings: SecretFinding[] = [];
  for (const file of output.split("\0").filter(Boolean)) {
    if (sensitiveTrackedFile.test(file) && !file.endsWith(".env.example")) {
      findings.push({ file, line: 1, rule: "sensitive-file" });
    }
    const contents = readFileSync(path.join(repoRoot, file));
    if (contents.includes(0)) {
      continue;
    }
    findings.push(...scanTextForSecrets(file, contents.toString("utf8")));
  }
  return findings;
};

const run = () => {
  const findings = scanTrackedFiles();
  if (findings.length > 0) {
    console.error("Secret scan failed. Matches are identified without printing secret values:");
    for (const finding of findings) {
      console.error(`- ${finding.file}:${finding.line} [${finding.rule}]`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("Secret scan passed: version-controlled candidate files contain no recognized credential signatures.");
};

if (import.meta.main) {
  run();
}
