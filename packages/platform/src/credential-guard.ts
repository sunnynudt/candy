const REDACTED_CREDENTIAL = "[REDACTED]";

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/giu,
  /\b(?:sk-(?:proj-)?|ds-|minimax-|gh[pousr]_|github_pat_|xox[baprs]-|npm_|pypi-)[A-Za-z0-9._~+/=-]{16,}\b/gu,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/giu,
  /((?:https?|ssh):\/\/)[^\s/@:]+:[^\s/@]+@/giu,
  /((?:api[-_ ]?key|access[-_ ]?key|authorization|client[-_ ]?secret|credential|password|private[-_ ]?key|secret(?:[-_ ]?key)?|token)\s*[:=]\s*)("[^"]{8,}"|'[^']{8,}'|[^\s,;]{8,})/giu,
];

export function containsCredentialMaterial(
  value: string,
  activeSecrets: readonly string[] = [],
): boolean {
  return (
    activeSecrets.some((secret) => secret.length > 0 && value.includes(secret)) ||
    CREDENTIAL_PATTERNS.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(value);
    })
  );
}

export function redactCredentialMaterial(
  value: string,
  activeSecrets: readonly string[] = [],
): string {
  const withActiveSecrets = activeSecrets.reduce(
    (result, secret) =>
      secret.length === 0 ? result : result.split(secret).join(REDACTED_CREDENTIAL),
    value,
  );
  return CREDENTIAL_PATTERNS.reduce(
    (result, pattern) =>
      result.replace(pattern, (match: string, ...replacementArguments: unknown[]) => {
        const label =
          replacementArguments.length >= 3 && typeof replacementArguments[0] === "string"
            ? replacementArguments[0]
            : undefined;
        return label === undefined ? REDACTED_CREDENTIAL : `${label}${REDACTED_CREDENTIAL}`;
      }),
    withActiveSecrets,
  );
}
