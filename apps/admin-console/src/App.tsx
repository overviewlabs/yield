import { FormEvent, useEffect, useRef, useState } from "react";
import {
  AdminAction,
  AdminRole,
  AdminState,
  applyAdminAction,
  can,
  initialAdminState,
  requiredReleaseFlags,
} from "./domain";
import { adminConfigurationStatus } from "./configuration";

type Section = "overview" | "users" | "compliance" | "agents" | "operations" | "security" | "audit";
type PendingAction = { readonly title: string; readonly detail: string; readonly action: AdminAction };

const navigation: readonly { readonly id: Section; readonly label: string; readonly glyph: string }[] = [
  { id: "overview", label: "Control center", glyph: "⌁" },
  { id: "users", label: "Users & support", glyph: "◎" },
  { id: "compliance", label: "Compliance", glyph: "◇" },
  { id: "agents", label: "Agents & rollout", glyph: "△" },
  { id: "operations", label: "Operations", glyph: "▦" },
  { id: "security", label: "Security", glyph: "◈" },
  { id: "audit", label: "Audit trail", glyph: "≡" },
];

const roles: readonly AdminRole[] = ["Support", "Compliance", "Operations", "Engineering", "Administrator"];
const deployment = import.meta.env.VITE_DEPLOYMENT_ENV ?? "demo";
const authMode = import.meta.env.VITE_ADMIN_AUTH_MODE ?? "mock";
const configurationStatus = adminConfigurationStatus(deployment, authMode);

function BrandMark() {
  return <span className="brand-mark" aria-hidden="true"><i /><b /></span>;
}

function Status({ tone, children }: { readonly tone: "good" | "warning" | "critical" | "neutral"; readonly children: React.ReactNode }) {
  return <span className={`status status-${tone}`}><i aria-hidden="true" />{children}</span>;
}

function ActionDialog({ pending, onCancel, onConfirm }: {
  readonly pending: PendingAction;
  readonly onCancel: () => void;
  readonly onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => input.current?.focus(), []);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section className="action-dialog" role="dialog" aria-modal="true" aria-labelledby="action-title">
        <p className="eyebrow">Audited administrative action</p>
        <h2 id="action-title">{pending.title}</h2>
        <p>{pending.detail}</p>
        <label htmlFor="action-reason">Required reason</label>
        <textarea ref={input} id="action-reason" value={reason} onChange={(event) => setReason(event.target.value)} rows={3} placeholder="Describe the operational or compliance basis" />
        <small>{reason.trim().length}/12 minimum characters</small>
        <div className="dialog-actions">
          <button className="button secondary" type="button" onClick={onCancel}>Cancel</button>
          <button className="button primary" type="button" onClick={() => onConfirm(reason)} disabled={reason.trim().length < 12}>Record and apply</button>
        </div>
      </section>
    </div>
  );
}

function DataTable({ caption, headers, rows }: { readonly caption: string; readonly headers: readonly string[]; readonly rows: readonly (readonly React.ReactNode[])[] }) {
  return (
    <div className="table-scroll">
      <table className="responsive-table">
        <caption className="sr-only">{caption}</caption>
        <thead><tr>{headers.map((header) => <th scope="col" key={header}>{header}</th>)}</tr></thead>
        <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td data-label={headers[cellIndex]} key={cellIndex}>{cell}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

export default function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [role, setRole] = useState<AdminRole>("Administrator");
  const [section, setSection] = useState<Section>("overview");
  const [state, setState] = useState<AdminState>(initialAdminState);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [justification, setJustification] = useState("");
  const [userVisible, setUserVisible] = useState(false);
  const actor = "admin.demo@whox.invalid";

  const confirmAction = (reason: string) => {
    if (pending === null) return;
    const result = applyAdminAction(state, pending.action, { actor, role, reason });
    if (result.error !== null) setError(result.error);
    else {
      setState(result.state);
      setAnnouncement(`${pending.title} completed and added to the audit trail.`);
      setError(null);
    }
    setPending(null);
  };

  const lookupUser = (event: FormEvent) => {
    event.preventDefault();
    if (!can(role, "lookup:user")) { setError(`${role} cannot access user lookup.`); return; }
    if (query.trim().length < 3 || justification.trim().length < 12) { setError("Enter a user reference and a specific access justification."); return; }
    setUserVisible(true);
    setError(null);
    setAnnouncement("One masked demo user record found. Access justification recorded for this session.");
  };

  if (configurationStatus !== "demo-ready") {
    const oidcUnconfigured = configurationStatus === "oidc-unconfigured";
    return <main className="login-shell"><section className="login-card"><BrandMark /><p className="eyebrow">Configuration stopped</p><h1>{oidcUnconfigured ? "OIDC administrator access is not configured." : "Mock administrator access is disabled outside Demo."}</h1><p>{oidcUnconfigured ? "This build has no OIDC token exchange, phishing-resistant MFA enforcement, API-backed role assignment, or durable audit integration. Configure and review those server boundaries before enabling administrative access." : "Use the simulated console only in Demo. Configure the complete OIDC, managed-device, server-role, API, and audit boundary before deploying Paper or Live."}</p></section></main>;
  }

  if (!authenticated) {
    return (
      <main className="login-shell">
        <section className="login-card" aria-labelledby="login-title">
          <BrandMark />
          <p className="eyebrow">Treasury Control</p>
          <h1 id="login-title">Administrative access</h1>
          <p>Production requires organization SSO, phishing-resistant MFA, device policy, and server-enforced roles.</p>
          <div className="demo-callout"><strong>Demo administrative environment</strong><span>Actions affect in-memory fixtures only. No broker or live service is contacted.</span></div>
          <button className="button primary wide" type="button" onClick={() => setAuthenticated(true)}>Use simulated security key</button>
          <small>Authorized personnel only. Every production access and action is audited.</small>
        </section>
      </main>
    );
  }

  const renderSection = () => {
    switch (section) {
      case "overview": return (
        <>
          <div className="page-heading"><div><p className="eyebrow">Control center</p><h1>System oversight</h1><p>Fail-closed posture across execution, broker connectivity, and regulatory gates.</p></div><Status tone="critical">Kill switch active</Status></div>
          <div className="metrics">
            <article><span>Broker connections</span><strong>98.7%</strong><small>Demo fleet · last 24h</small></article>
            <article><span>Reconciliation lag</span><strong>42s</strong><small>Below 120s alert threshold</small></article>
            <article><span>Queue depth</span><strong>128</strong><small>6 oldest seconds</small></article>
            <article><span>Risk rejections</span><strong>23</strong><small>Expected deterministic controls</small></article>
          </div>
          <section className="content-card critical-card"><div><p className="eyebrow">Execution control</p><h2>System-wide kill switch</h2><p>New submissions are blocked. Reconciliation and position monitoring continue. This demo control cannot enable Live because every release flag remains false.</p></div><button className="button danger" type="button" disabled={!can(role, "control:kill-switch")} onClick={() => setPending({ title: state.killSwitchActive ? "Resume demo execution" : "Engage execution kill switch", detail: "This changes only the demo execution posture. Live gates remain closed.", action: { type: "SET_KILL_SWITCH", active: !state.killSwitchActive } })}>{state.killSwitchActive ? "Review demo resume" : "Engage kill switch"}</button></section>
          <div className="two-column">
            <section className="content-card"><div className="card-heading"><div><p className="eyebrow">Release gates</p><h2>Live activation</h2></div><Status tone="critical">7 closed</Status></div><ul className="gate-list">{requiredReleaseFlags.map((flag) => <li key={flag}><span>{flag}</span><Status tone="critical">False</Status></li>)}</ul><p className="footnote">External approvals cannot be overridden from this demo console.</p></section>
            <section className="content-card"><div className="card-heading"><div><p className="eyebrow">Current incident</p><h2>Operator banner</h2></div><Status tone="warning">Visible</Status></div><p className="incident-copy">{state.incidentBanner ?? "No active incident banner."}</p><button className="button secondary" type="button" disabled={!can(role, "manage:incident")} onClick={() => setPending({ title: state.incidentBanner === null ? "Publish incident banner" : "Clear incident banner", detail: "The reason will be preserved even if the banner is cleared.", action: { type: "SET_INCIDENT", message: state.incidentBanner === null ? "Paper execution maintenance is in progress." : null } })}>{state.incidentBanner === null ? "Publish demo banner" : "Clear demo banner"}</button></section>
          </div>
        </>
      );
      case "users": return (
        <>
          <div className="page-heading"><div><p className="eyebrow">Users & support</p><h1>Justified access</h1><p>Searches are scoped, masked, and recorded. Full account numbers and broker tokens are never shown.</p></div></div>
          <section className="content-card"><form className="lookup-form" onSubmit={lookupUser}><div><label htmlFor="user-query">User reference</label><input id="user-query" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Email or user ID" /></div><div><label htmlFor="justification">Access justification</label><input id="justification" value={justification} onChange={(event) => setJustification(event.target.value)} placeholder="Ticket, complaint, or operational reason" /></div><button className="button primary" type="submit">Search masked records</button></form></section>
          {userVisible && <section className="content-card user-record"><div className="card-heading"><div><p className="eyebrow">Demo user</p><h2>Jordan Review</h2><p>user_demo_4f28 · j•••••@privaterelay.example</p></div><Status tone={state.userPaused ? "warning" : "good"}>{state.userPaused ? "Paused" : "Monitoring"}</Status></div><dl className="record-grid"><div><dt>Account mode</dt><dd>Demo</dd></div><div><dt>Agentic account</dt><dd>•••• 2841</dd></div><div><dt>Portfolio value</dt><dd>$••••</dd></div><div><dt>Subscription</dt><dd>Equity Pro fixture</dd></div><div><dt>Connection</dt><dd>Healthy · simulated</dd></div><div><dt>Risk state</dt><dd>Within demo limits</dd></div></dl><button className="button secondary" type="button" disabled={!can(role, "pause:user")} onClick={() => setPending({ title: state.userPaused ? "Resume demo user" : "Pause demo user", detail: "Pausing prevents new proposals and submissions; it does not liquidate positions.", action: { type: "SET_USER_PAUSE", paused: !state.userPaused } })}>{state.userPaused ? "Review resume" : "Review trading pause"}</button></section>}
        </>
      );
      case "compliance": return (
        <><div className="page-heading"><div><p className="eyebrow">Compliance</p><h1>Documents & records</h1><p>Fixtures demonstrate versioning workflows only; counsel-approved production documents are not loaded.</p></div><Status tone="critical">Approval blocked</Status></div><div className="two-column"><section className="content-card"><h2>Legal document versions</h2><DataTable caption="Legal document versions" headers={["Document", "Version", "State"]} rows={[["Terms of Service", "fixture-0.4", <Status tone="warning">Nonproduction</Status>],["AI Agent Risk Disclosure", "fixture-0.3", <Status tone="warning">Nonproduction</Status>],["Options Risk Disclosure", "not loaded", <Status tone="critical">Required</Status>],["Advisory Agreement", "not loaded", <Status tone="critical">Required</Status>]]} /></section><section className="content-card"><h2>Consent records</h2><DataTable caption="Consent record summary" headers={["Scope", "Accepted", "Version"]} rows={[["Demo terms", "Aug 1, 2026", "fixture-0.4"],["Electronic communications", "Aug 1, 2026", "fixture-0.2"],["Live documents", "—", "Not approved"]]} /></section></div><section className="content-card"><div className="card-heading"><div><h2>Complaint tracking</h2><p>Support case SUP-1042 was classified for compliance review.</p></div><Status tone="warning">Open · 2h</Status></div><p className="footnote">Category: agent behavior · Mode: Demo · Financial values masked · Legal hold: no</p></section></>
      );
      case "agents": return (
        <><div className="page-heading"><div><p className="eyebrow">Agents & rollout</p><h1>Version controls</h1><p>Canaries are limited to Paper until production, legal, and compliance gates are approved.</p></div></div><section className="content-card"><DataTable caption="Agent versions" headers={["Agent", "Version", "Environment", "Status", "Action"]} rows={[["Foundation Equity", "1.2.0", "Paper", <Status tone="good">Healthy</Status>, <button className="table-button" disabled={!can(role,"pause:strategy")} onClick={() => setPending({ title: state.strategyPaused ? "Resume Foundation Equity" : "Pause Foundation Equity", detail: "The strategy pause stops new proposals and keeps monitoring active.", action: { type: "SET_STRATEGY_PAUSE", paused: !state.strategyPaused } })}>{state.strategyPaused ? "Resume" : "Pause"}</button>],["Equity Momentum", "1.1.0-rc.3", "Paper canary", <Status tone="warning">{state.rolloutPercent}% rollout</Status>, "Structured rationale v4"],["Defined-Risk Spreads", "0.6.0", "Disabled", <Status tone="critical">Approval required</Status>, "No rollout"]]} /></section><section className="content-card rollout"><div><h2>Equity Momentum paper canary</h2><p>Change the simulated Paper cohort only. This cannot reach Live execution.</p></div><div className="rollout-control"><label htmlFor="rollout">Proposed cohort <strong>{Math.min(100, state.rolloutPercent + 5)}%</strong></label><input id="rollout" type="range" min="0" max="100" step="5" value={Math.min(100, state.rolloutPercent + 5)} readOnly /><button className="button secondary" disabled={!can(role,"manage:rollout")} onClick={() => setPending({ title: "Update paper canary", detail: "Only deterministic Paper fixtures will enter the selected cohort.", action: { type: "SET_ROLLOUT", percent: Math.min(100, state.rolloutPercent + 5) } })}>Record +5% rollout</button></div></section></>
      );
      case "operations": return (
        <><div className="page-heading"><div><p className="eyebrow">Operations</p><h1>Service health</h1><p>Critical dependency failure causes trading to fail closed.</p></div><Status tone="good">Demo services healthy</Status></div><div className="metrics"><article><span>Execution queue</span><strong>0</strong><small>Submissions blocked</small></article><article><span>Reconciliation</span><strong>4</strong><small>All within SLA</small></article><article><span>Notifications</span><strong>2</strong><small>Retrying demo sends</small></article><article><span>Broker tools</span><strong>47</strong><small>Last discovery fixture</small></article></div><section className="content-card"><h2>Dependency checks</h2><DataTable caption="Dependency checks" headers={["Service", "State", "Freshness", "Trading effect"]} rows={[["PostgreSQL", <Status tone="good">Healthy</Status>, "12s", "None"],["Redis locks", <Status tone="good">Healthy</Status>, "8s", "None"],["Durable queues", <Status tone="good">Healthy</Status>, "6s", "None"],["Robinhood Trading MCP", <Status tone="warning">Demo fixture</Status>, "42s", "Live blocked"],["Audit log", <Status tone="good">Healthy</Status>, "3s", "Fail closed if unavailable"]]} /></section></>
      );
      case "security": return (
        <><div className="page-heading"><div><p className="eyebrow">Security</p><h1>Identity & events</h1><p>Broker tokens are encrypted server-side and unavailable to ordinary API and administrator views.</p></div></div>{!can(role,"view:security") ? <section className="empty-state"><h2>Role access required</h2><p>Security event detail is limited to Engineering and Administrator roles.</p></section> : <section className="content-card"><DataTable caption="Security events" headers={["Time", "Event", "Actor", "Result"]} rows={[["08:31 EDT", "Admin security-key authentication", "admin.demo", <Status tone="good">Allowed</Status>],["08:19 EDT", "Pairing-code rate limit", "anonymous", <Status tone="warning">Blocked</Status>],["07:44 EDT", "OAuth state mismatch", "session ••••71", <Status tone="critical">Rejected</Status>],["07:00 EDT", "Broker token decrypt check", "execution-worker", <Status tone="good">Healthy</Status>]]} /></section>}<section className="content-card"><h2>Token boundary</h2><ul className="plain-list"><li>Ordinary API tasks cannot read broker-token ciphertext keys.</li><li>Execution workers receive narrowly scoped decrypt permission.</li><li>Tokens are never placed in URLs, analytics, browser storage, or model context.</li><li>OAuth authorization codes are redacted before log ingestion.</li></ul></section></>
      );
      case "audit": return (
        <><div className="page-heading"><div><p className="eyebrow">Audit trail</p><h1>Administrative actions</h1><p>Append-only demo events show the production record shape.</p></div></div>{!can(role,"view:audit") ? <section className="empty-state"><h2>Role access required</h2><p>Audit records are limited to Compliance, Operations, Engineering, and Administrator roles.</p></section> : <section className="content-card"><DataTable caption="Administrative audit events" headers={["Time", "Actor / role", "Action", "Reason", "Before → after", "Correlation"]} rows={state.auditEvents.map((event) => [new Date(event.timestamp).toLocaleString(), <><strong>{event.actor}</strong><small>{event.role}</small></>, event.action, event.reason, `${event.before} → ${event.after}`, <code>{event.correlationId}</code>])} /></section>}</>
      );
    }
  };

  return (
    <div className="admin-shell">
      <a href="#main-content" className="skip-link">Skip to content</a>
      <aside className="sidebar">
        <div className="admin-brand"><BrandMark /><div><strong>WHOX</strong><span>Treasury Control</span></div></div>
        <span className="environment-pill">Demo · no live trading</span>
        <nav aria-label="Administrative sections">{navigation.map((item) => <button type="button" key={item.id} className={section === item.id ? "active" : ""} onClick={() => setSection(item.id)} aria-current={section === item.id ? "page" : undefined}><span aria-hidden="true">{item.glyph}</span>{item.label}</button>)}</nav>
        <div className="sidebar-foot"><Status tone="critical">Execution blocked</Status><span>Build 0.1.0-demo</span></div>
      </aside>
      <div className="workspace">
        <header className="topbar"><button className="mobile-brand" type="button" onClick={() => setSection("overview")}><BrandMark />Control</button><div className="role-control"><label htmlFor="role">Simulated role</label><select id="role" value={role} onChange={(event) => { setRole(event.target.value as AdminRole); setUserVisible(false); }}>{roles.map((item) => <option key={item}>{item}</option>)}</select><button className="avatar" type="button" onClick={() => setAuthenticated(false)} aria-label="Sign out demo administrator">AD</button></div></header>
        {state.incidentBanner !== null && <div className="incident-banner" role="status"><strong>Operational notice</strong><span>{state.incidentBanner}</span></div>}
        <main id="main-content" className="page-content">{error !== null && <div className="error-banner" role="alert">{error}<button type="button" onClick={() => setError(null)} aria-label="Dismiss error">×</button></div>}{renderSection()}</main>
      </div>
      {pending !== null && <ActionDialog pending={pending} onCancel={() => setPending(null)} onConfirm={confirmAction} />}
      <p className="sr-only" aria-live="polite">{announcement}</p>
    </div>
  );
}
