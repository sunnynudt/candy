/**
 * Candy credential material detection (product-wide).
 *
 * Two sources of credential material are recognized:
 * - unambiguous credential shapes (provider prefixes, bearer values, key
 *   blocks, URLs with inline userinfo), and
 * - a label such as token/password/secret followed by a value, which is only
 *   treated as credential material when that value looks like data.
 *
 * The second rule is deliberately semantic: credential-handling source code
 * legitimately writes labels next to long values (function type annotations,
 * member references, keyword expressions, type syntax). Treating those as
 * credential material made Candy's own write and commit guards refuse edits to
 * that code, so they are filtered out here instead.
 */

/** Marker written in place of credential material. */
const REDACTED_VALUE = "[REDACTED]";

/** Credential shapes that are unambiguous on their own. */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/giu,
  /\b(?:sk-(?:proj-)?|ds-|minimax-|gh[pousr]_|github_pat_|xox[baprs]-|npm_|pypi-)[A-Za-z0-9._~+/=-]{16,}\b/gu,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/giu,
  /((?:https?|ssh):\/\/)[^\s/@:]+:[^\s/@]+@/giu,
];

/** A label followed by a value; the value is inspected before it counts. */
const LABELED_VALUE_PATTERN =
  /((?:api[-_ ]?key|access[-_ ]?key|authorization|client[-_ ]?secret|credential|password|private[-_ ]?key|secret(?:[-_ ]?key)?|token)\s*[:=]\s*)("[^"]{8,}"|'[^']{8,}'|[^\s,;]{8,})/giu;

/** Compact tokens of three long segments are credentials, not member chains. */
const JSON_WEB_TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/u;

/**
 * True when a labeled value is source code, a reference, or a keyword rather
 * than credential data. Quoted strings and dotted web tokens are data and fall
 * through to redaction.
 */
export function isCodeLikeValue(value: string): boolean {
  if (value.startsWith('"') || value.startsWith("'")) return false;
  if (JSON_WEB_TOKEN_PATTERN.test(value)) return false;
  if (/[()[\]{}<>`$?!|&;]/u.test(value)) return true;
  if (/^[A-Za-z_$][\w$]*(?:\.[\w$#]+)+$/u.test(value)) return true;
  return /^(?:true|false|null|undefined|await|new|import|require)$/u.test(value);
}

function labeledValues(value: string): readonly string[] {
  LABELED_VALUE_PATTERN.lastIndex = 0;
  return [...value.matchAll(LABELED_VALUE_PATTERN)]
    .map((match) => match[2] ?? "")
    .filter((candidate) => !isCodeLikeValue(candidate));
}

export function containsCredentialMaterial(
  value: string,
  activeSecrets: readonly string[] = [],
): boolean {
  return (
    activeSecrets.some((secretValue) => secretValue.length > 0 && value.includes(secretValue)) ||
    CREDENTIAL_PATTERNS.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(value);
    }) ||
    labeledValues(value).length > 0
  );
}

export function redactCredentialMaterial(
  value: string,
  activeSecrets: readonly string[] = [],
): string {
  const withActiveSecrets = activeSecrets.reduce(
    (result, secretValue) =>
      secretValue.length === 0 ? result : result.split(secretValue).join(REDACTED_VALUE),
    value,
  );
  const withPatterns = CREDENTIAL_PATTERNS.reduce(
    (result, pattern) =>
      result.replace(pattern, (match: string, ...replacementArguments: unknown[]) => {
        const label =
          replacementArguments.length >= 3 && typeof replacementArguments[0] === "string"
            ? replacementArguments[0]
            : undefined;
        return label === undefined ? REDACTED_VALUE : `${label}${REDACTED_VALUE}`;
      }),
    withActiveSecrets,
  );
  return withPatterns.replace(
    LABELED_VALUE_PATTERN,
    (match: string, label: string, candidate: string) =>
      isCodeLikeValue(candidate) ? match : `${label}${REDACTED_VALUE}`,
  );
}
