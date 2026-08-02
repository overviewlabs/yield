import { formatPairingCode } from "./pairingMachine";

export type PairingRoute = {
  readonly callbackPairingId: string | null;
  readonly desktopCompletion: "complete" | "failed" | null;
  readonly initialCode: string;
  readonly sanitizedPath: string;
  readonly containsSensitiveQuery: boolean;
};

export function parsePairingRoute(href: string): PairingRoute {
  const url = new URL(href);
  const callbackPairingId = url.searchParams.get("result") === "connected"
    ? url.searchParams.get("pairingId") ?? url.searchParams.get("pairing_id")
    : null;
  return {
    callbackPairingId,
    desktopCompletion: url.hash === "#desktop-complete"
      ? "complete"
      : url.hash === "#desktop-failed" ? "failed" : null,
    initialCode: formatPairingCode(url.searchParams.get("pairing_code") ?? ""),
    sanitizedPath: `${url.pathname}${url.hash}`,
    containsSensitiveQuery: url.search.length > 0,
  };
}
