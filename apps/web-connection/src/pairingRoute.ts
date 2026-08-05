import { formatPairingCode } from "./pairingMachine";

export type PairingRoute = {
  readonly callbackPairingId: string | null;
  readonly desktopCompletion: "complete" | "failed" | null;
  readonly desktopAuthorizationUrl: string | null;
  readonly initialCode: string;
  readonly sanitizedPath: string;
  readonly containsSensitiveQuery: boolean;
};

export function parsePairingRoute(href: string): PairingRoute {
  const url = new URL(href);
  const desktopAuthorizationUrl = url.pathname === "/desktop"
    ? new URLSearchParams(url.hash.slice(1)).get("authorization")
    : null;
  const callbackPairingId = url.searchParams.get("result") === "connected"
    ? url.searchParams.get("pairingId") ?? url.searchParams.get("pairing_id")
    : null;
  return {
    callbackPairingId,
    desktopCompletion: url.hash === "#desktop-complete"
      ? "complete"
      : url.hash === "#desktop-failed" ? "failed" : null,
    desktopAuthorizationUrl,
    initialCode: formatPairingCode(url.searchParams.get("pairing_code") ?? ""),
    sanitizedPath: desktopAuthorizationUrl === null ? `${url.pathname}${url.hash}` : url.pathname,
    containsSensitiveQuery: url.search.length > 0 || desktopAuthorizationUrl !== null,
  };
}

export function validatedDesktopAuthorizationUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || (host !== "robinhood.com" && !host.endsWith(".robinhood.com")) || url.username !== "" || url.password !== "" || url.hash !== "") return null;
    return url.href;
  } catch {
    return null;
  }
}

export function isMobileBrowser(userAgent: string, platform: string, maxTouchPoints: number): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent)
    || (platform === "MacIntel" && maxTouchPoints > 1);
}
