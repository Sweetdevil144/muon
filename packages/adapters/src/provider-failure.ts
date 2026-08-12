const DELIMITED_CREDENTIAL_NAME =
  String.raw`(?:[A-Za-z][A-Za-z0-9]*[_-])*(?:API[_-]?KEY|KEY|TOKEN|SECRET|CREDENTIALS?|AUTH(?:ORIZATION)?|PASS(?:WORD|WD)|CONNECTION[_-]?STRING)`;

const COMMON_COMPACT_CREDENTIAL_NAME =
  String.raw`(?:access|refresh|id|client|private|session|github|gitlab|azure|openai|anthropic|muon)(?:ApiKey|Key|Token|Secret|Credentials|Authorization|Auth|Password|Passwd)`;

const CREDENTIAL_NAME =
  String.raw`(?:${DELIMITED_CREDENTIAL_NAME}|${COMMON_COMPACT_CREDENTIAL_NAME})`;

const AUTHORIZATION_HEADER =
  /\b(?:proxy-)?authorization\s*[:=]\s*(?:bearer|basic)\s+\S+/gi;

const CREDENTIAL_ASSIGNMENT = new RegExp(
  String.raw`(^|[\s?&;,{}\[\].])(["']?)(${CREDENTIAL_NAME})\2\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s&,;}\]]+)`,
  "gi"
);

/**
 * Provider failures can contain argv, environment, URL-query, or JSON
 * fragments. Preserve the credential name for diagnosis while removing the
 * value before the failure crosses into durable streams or user-visible text.
 */
export function boundedProviderFailure(
  value: unknown,
  maxLength = 500
): string {
  let raw: string;
  try {
    raw = value instanceof Error ? value.message : String(value);
  } catch {
    raw = "Unknown provider failure";
  }
  return raw
    .replace(AUTHORIZATION_HEADER, "authorization=[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      CREDENTIAL_ASSIGNMENT,
      (_match, prefix: string, quote: string, name: string) =>
        `${prefix}${quote}${name}${quote}=[redacted]`
    )
    .replace(/\b(?:sk|sess|key)-[A-Za-z0-9_-]{16,}\b/g, "[redacted]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}
