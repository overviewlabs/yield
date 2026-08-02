export type AdminRole = "Support" | "Compliance" | "Operations" | "Engineering" | "Administrator";

export type Permission =
  | "lookup:user"
  | "pause:user"
  | "pause:strategy"
  | "control:kill-switch"
  | "manage:incident"
  | "manage:rollout"
  | "manage:legal"
  | "view:security"
  | "view:audit";

const permissions: Readonly<Record<AdminRole, readonly Permission[]>> = {
  Support: ["lookup:user"],
  Compliance: ["lookup:user", "pause:user", "manage:legal", "view:audit"],
  Operations: ["lookup:user", "pause:user", "pause:strategy", "manage:incident", "view:audit"],
  Engineering: ["pause:strategy", "manage:rollout", "view:security", "view:audit"],
  Administrator: [
    "lookup:user",
    "pause:user",
    "pause:strategy",
    "control:kill-switch",
    "manage:incident",
    "manage:rollout",
    "manage:legal",
    "view:security",
    "view:audit",
  ],
};

export function can(role: AdminRole, permission: Permission): boolean {
  return permissions[role].includes(permission);
}

export const requiredReleaseFlags = [
  "LIVE_TRADING_ENABLED",
  "ROBINHOOD_PRODUCTION_APPROVED",
  "LEGAL_DOCUMENTS_APPROVED",
  "ADVISORY_COMPLIANCE_APPROVED",
  "APP_STORE_FINANCIAL_ENTITY_APPROVED",
  "OPTIONS_LIVE_TRADING_ENABLED",
  "AUTONOMOUS_MODE_ENABLED",
] as const;

export type ReleaseFlag = (typeof requiredReleaseFlags)[number];

export type AuditEvent = {
  readonly id: string;
  readonly actor: string;
  readonly role: AdminRole;
  readonly action: string;
  readonly reason: string;
  readonly before: string;
  readonly after: string;
  readonly timestamp: string;
  readonly correlationId: string;
};

export type AdminState = {
  readonly releaseFlags: Readonly<Record<ReleaseFlag, false>>;
  readonly killSwitchActive: boolean;
  readonly userPaused: boolean;
  readonly strategyPaused: boolean;
  readonly incidentBanner: string | null;
  readonly rolloutPercent: number;
  readonly auditEvents: readonly AuditEvent[];
};

export const initialAdminState: AdminState = {
  releaseFlags: Object.fromEntries(requiredReleaseFlags.map((flag) => [flag, false])) as Record<ReleaseFlag, false>,
  killSwitchActive: true,
  userPaused: false,
  strategyPaused: false,
  incidentBanner: "Live execution is disabled. Demo is available; Paper requires approved external services.",
  rolloutPercent: 0,
  auditEvents: [
    {
      id: "audit-seed",
      actor: "system",
      role: "Administrator",
      action: "EXECUTION_KILL_SWITCH_ENGAGED",
      reason: "Default fail-closed startup policy",
      before: "unknown",
      after: "active",
      timestamp: "2026-08-01T07:00:00.000Z",
      correlationId: "corr-demo-bootstrap",
    },
  ],
};

export type AdminAction =
  | { readonly type: "SET_KILL_SWITCH"; readonly active: boolean }
  | { readonly type: "SET_USER_PAUSE"; readonly paused: boolean }
  | { readonly type: "SET_STRATEGY_PAUSE"; readonly paused: boolean }
  | { readonly type: "SET_INCIDENT"; readonly message: string | null }
  | { readonly type: "SET_ROLLOUT"; readonly percent: number };

type ActionContext = {
  readonly actor: string;
  readonly role: AdminRole;
  readonly reason: string;
  readonly now?: string;
  readonly correlationId?: string;
};

type ApplyResult = { readonly state: AdminState; readonly error: string | null };

function neededPermission(action: AdminAction): Permission {
  switch (action.type) {
    case "SET_KILL_SWITCH": return "control:kill-switch";
    case "SET_USER_PAUSE": return "pause:user";
    case "SET_STRATEGY_PAUSE": return "pause:strategy";
    case "SET_INCIDENT": return "manage:incident";
    case "SET_ROLLOUT": return "manage:rollout";
  }
}

export function applyAdminAction(state: AdminState, action: AdminAction, context: ActionContext): ApplyResult {
  if (!can(context.role, neededPermission(action))) {
    return { state, error: `${context.role} does not have permission for this action.` };
  }
  if (context.reason.trim().length < 12) {
    return { state, error: "Enter a specific reason of at least 12 characters." };
  }

  let next: AdminState = state;
  let before = "";
  let after = "";
  switch (action.type) {
    case "SET_KILL_SWITCH":
      before = state.killSwitchActive ? "active" : "inactive";
      after = action.active ? "active" : "inactive";
      next = { ...state, killSwitchActive: action.active };
      break;
    case "SET_USER_PAUSE":
      before = state.userPaused ? "paused" : "monitoring";
      after = action.paused ? "paused" : "monitoring";
      next = { ...state, userPaused: action.paused };
      break;
    case "SET_STRATEGY_PAUSE":
      before = state.strategyPaused ? "paused" : "paper";
      after = action.paused ? "paused" : "paper";
      next = { ...state, strategyPaused: action.paused };
      break;
    case "SET_INCIDENT":
      before = state.incidentBanner ?? "none";
      after = action.message ?? "none";
      next = { ...state, incidentBanner: action.message };
      break;
    case "SET_ROLLOUT": {
      const bounded = Math.max(0, Math.min(100, Math.round(action.percent)));
      before = `${state.rolloutPercent}%`;
      after = `${bounded}%`;
      next = { ...state, rolloutPercent: bounded };
      break;
    }
  }

  const event: AuditEvent = {
    id: `audit-${state.auditEvents.length + 1}`,
    actor: context.actor,
    role: context.role,
    action: action.type,
    reason: context.reason.trim(),
    before,
    after,
    timestamp: context.now ?? new Date().toISOString(),
    correlationId: context.correlationId ?? `corr-demo-${state.auditEvents.length + 1}`,
  };
  return { state: { ...next, auditEvents: [event, ...state.auditEvents] }, error: null };
}
