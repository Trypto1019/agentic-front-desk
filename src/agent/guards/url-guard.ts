/**
 * Outbound URL guard. The model may send a link only when the exact URL was
 * supplied this turn by the server: a fixed portal URL from configuration or
 * a URL inside a tool result. It must never construct, recall, guess,
 * shorten or complete one. Fails closed.
 *
 * Owned public hosts are allowed only at known public entry points; anything
 * that could carry a token or name a purchasable product must arrive verbatim
 * from a tool result.
 */

const URL_CANDIDATE =
  /[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+|www\.[^\s<>"']+|\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}(?:\/[^\s<>"']*)?/gi;

export type UrlPolicy = { portalUrls: readonly string[]; ownedHosts: readonly string[] };

export type OutboundUrlGuardResult = { allowed: true; urls: string[] } | { allowed: false; urls: string[]; blockedUrls: string[] };

function trimSentencePunctuation(value: string): string {
  return value.replace(/[.,!?;:)}\]’”]+$/g, "");
}

export function extractOutboundUrls(text: string): string[] {
  return Array.from(text.matchAll(URL_CANDIDATE), (m) => trimSentencePunctuation(m[0])).filter(Boolean);
}

/** Collect exact links from tool results: string values only, never object keys. */
export function collectToolResultUrls(value: unknown): string[] {
  const urls = new Set<string>();
  const seen = new Set<object>();
  const visit = (current: unknown, depth: number) => {
    if (depth > 12) return;
    if (typeof current === "string") {
      for (const url of extractOutboundUrls(current)) urls.add(url);
      return;
    }
    if (!current || typeof current !== "object" || seen.has(current)) return;
    seen.add(current);
    for (const item of Array.isArray(current) ? current : Object.values(current)) visit(item, depth + 1);
  };
  visit(value, 0);
  return [...urls];
}

export function canonicalizeUrl(value: string): string | null {
  const candidate = trimSentencePunctuation(value.trim());
  if (!candidate) return null;
  const withScheme = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
  try {
    const parsed = new URL(withScheme);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    parsed.hostname = parsed.hostname.toLowerCase();
    if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/$/, "");
    return parsed.toString();
  } catch {
    return null;
  }
}

function ownedPublicRoot(canonical: string, policy: UrlPolicy): boolean {
  const url = new URL(canonical);
  return policy.ownedHosts.includes(url.hostname) && !url.port && url.pathname === "/" && !url.search && !url.hash;
}

export function guardGeneratedUrls(text: string, policy: UrlPolicy, turnAllowedUrls: readonly string[] = []): OutboundUrlGuardResult {
  const urls = extractOutboundUrls(text);
  if (urls.length === 0) return { allowed: true, urls: [] };
  const allowlist = new Set([...policy.portalUrls, ...turnAllowedUrls].map(canonicalizeUrl).filter((u): u is string => u != null));
  const blockedUrls = urls.filter((url) => {
    const canonical = canonicalizeUrl(url);
    return canonical == null || (!allowlist.has(canonical) && !ownedPublicRoot(canonical, policy));
  });
  return blockedUrls.length === 0 ? { allowed: true, urls } : { allowed: false, urls, blockedUrls };
}
