export function sanitizeRailDiagnostic(value: string | null): string | null {
  if (value === null) return null;
  return value
    .slice(0, 1024)
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, "[REDACTED_URL]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(
      /\b(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*[^,\s;]+/gi,
      "$1=[REDACTED]",
    )
    .replace(
      /([?&](?:api[_-]?key|apikey|token|secret|password|auth|access_token)=)[^&\s]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\bS[A-Z2-7]{55}\b/g, "[REDACTED_STELLAR_SECRET]")
    .slice(0, 256);
}
