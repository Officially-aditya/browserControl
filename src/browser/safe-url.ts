/**
 * Centralized safe-navigation validator for browserControl.
 *
 * Only http/https navigations are permitted (plus about:blank for new tabs).
 * This is enforced below the model so prompt-injected URLs cannot exfiltrate
 * local files or escape to privileged schemes.
 */

export const MAX_NAVIGATION_URL_LENGTH = 2048;

const BLOCKED_PROTOCOLS = new Set([
  "file:",
  "javascript:",
  "data:",
  "chrome:",
  "chrome-extension:",
  "chrome-search:",
  "chrome-devtools:",
  "devtools:",
  "view-source:",
  "blob:",
  "filesystem:",
  "about:",
]);

export function isSafeNavigationUrl(rawUrl: string): boolean {
  if (typeof rawUrl !== "string") return false;
  const url = rawUrl.trim();
  if (!url || url.length > MAX_NAVIGATION_URL_LENGTH) return false;
  // Reject control characters / whitespace that enable scheme smuggling.
  if (/[\x00-\x20]/.test(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

export function isSafeNewTabUrl(rawUrl: string | undefined): boolean {
  if (rawUrl === undefined || rawUrl === "about:blank") return true;
  return isSafeNavigationUrl(rawUrl);
}

export function assertSafeNavigationUrl(rawUrl: string): string {
  const url = (rawUrl || "").trim();
  if (!isSafeNavigationUrl(url)) {
    throw Object.assign(
      new Error(
        `Blocked unsafe navigation URL (only http/https up to ${MAX_NAVIGATION_URL_LENGTH} chars are allowed)`
      ),
      { code: "UNSAFE_NAVIGATION_URL" }
    );
  }
  return url;
}

export function assertSafeNewTabUrl(rawUrl: string | undefined): string {
  if (rawUrl === undefined || rawUrl === "about:blank") return "about:blank";
  return assertSafeNavigationUrl(rawUrl);
}

/** For logging without leaking full URLs. */
export function blockedProtocol(rawUrl: string): string {
  try {
    return new URL(rawUrl).protocol;
  } catch {
    return "(unparseable)";
  }
}

export { BLOCKED_PROTOCOLS };
