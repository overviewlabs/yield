export type PairingStage =
  | "enterCode"
  | "identity"
  | "review"
  | "authorizing"
  | "connected"
  | "complete"
  | "expired"
  | "error";

export type Capability = {
  readonly label: string;
  readonly status: "available" | "restricted" | "unavailable";
  readonly detail: string;
};

export type PairingSession = {
  readonly id: string;
  readonly displayCode: string;
  readonly expiresAt: string;
  readonly identityHint: string;
  readonly accountMode: "Demo" | "Paper" | "Live";
};

export type ConnectionReceipt = {
  readonly maskedAccountIdentifier: string;
  readonly accountType: string;
  readonly capabilities: readonly Capability[];
  readonly lastSuccessfulSync?: string;
};

export type PairingState = {
  readonly stage: PairingStage;
  readonly code: string;
  readonly session: PairingSession | null;
  readonly receipt: ConnectionReceipt | null;
  readonly message: string | null;
};

export type PairingAction =
  | { readonly type: "CODE_CHANGED"; readonly code: string }
  | { readonly type: "CODE_ACCEPTED"; readonly session: PairingSession }
  | { readonly type: "IDENTITY_VERIFIED" }
  | { readonly type: "AUTHORIZATION_STARTED" }
  | { readonly type: "CONNECTION_CONFIRMED"; readonly receipt: ConnectionReceipt }
  | { readonly type: "RESTORED_CONNECTED"; readonly session: PairingSession; readonly receipt: ConnectionReceipt }
  | { readonly type: "FINISHED" }
  | { readonly type: "EXPIRED" }
  | { readonly type: "FAILED"; readonly message: string }
  | { readonly type: "RESET"; readonly code?: string };

export const initialPairingState: PairingState = {
  stage: "enterCode",
  code: "",
  session: null,
  receipt: null,
  message: null,
};

const allowedCharacters = /^[A-HJ-NP-Z2-9]{8}$/;

export function compactPairingCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}

export function formatPairingCode(input: string): string {
  const compact = compactPairingCode(input);
  return compact.length > 4 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact;
}

export function isValidPairingCode(input: string): boolean {
  return allowedCharacters.test(compactPairingCode(input));
}

export function secondsUntil(isoTimestamp: string, now = Date.now()): number {
  const remaining = Math.floor((Date.parse(isoTimestamp) - now) / 1_000);
  return Math.max(0, remaining);
}

export function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

export function pairingReducer(state: PairingState, action: PairingAction): PairingState {
  switch (action.type) {
    case "CODE_CHANGED":
      return { ...state, code: formatPairingCode(action.code), message: null };
    case "CODE_ACCEPTED":
      if (state.stage !== "enterCode" && state.stage !== "error") return state;
      return {
        ...state,
        stage: "identity",
        code: action.session.displayCode,
        session: action.session,
        message: null,
      };
    case "IDENTITY_VERIFIED":
      return state.stage === "identity" ? { ...state, stage: "review", message: null } : state;
    case "AUTHORIZATION_STARTED":
      return state.stage === "review" ? { ...state, stage: "authorizing", message: null } : state;
    case "CONNECTION_CONFIRMED":
      return state.stage === "authorizing"
        ? { ...state, stage: "connected", receipt: action.receipt, message: null }
        : state;
    case "RESTORED_CONNECTED":
      return {
        ...state,
        stage: "connected",
        code: action.session.displayCode,
        session: action.session,
        receipt: action.receipt,
        message: null,
      };
    case "FINISHED":
      return state.stage === "connected" ? { ...state, stage: "complete" } : state;
    case "EXPIRED":
      return state.session === null || state.stage === "connected" || state.stage === "complete"
        ? state
        : { ...state, stage: "expired", message: "This pairing code expired before it was used." };
    case "FAILED":
      return { ...state, stage: "error", message: action.message };
    case "RESET":
      return {
        ...initialPairingState,
        code: action.code === undefined ? "" : formatPairingCode(action.code),
      };
  }
}
