import { FormEvent, useEffect, useMemo, useReducer, useState } from "react";
import {
  formatCountdown,
  initialPairingState,
  isValidPairingCode,
  pairingReducer,
  secondsUntil,
} from "./pairingMachine";
import { createApiPairingClient, createMockPairingClient } from "./pairingClient";
import { parsePairingRoute } from "./pairingRoute";

const deployment = import.meta.env.VITE_DEPLOYMENT_ENV ?? "demo";
const provider = import.meta.env.VITE_PAIRING_PROVIDER ?? "mock";
const isDemo = deployment === "demo" && provider === "mock";
const configurationIsSafe = deployment === "demo" || provider === "api";
const accountMode = deployment === "live" ? "Live" : deployment === "paper" ? "Paper" : "Demo";

function TreasuryMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 48 48" role="img" aria-label="Yield">
      <path d="M24 4 40 12v12c0 10.2-6.3 16.5-16 20C14.3 40.5 8 34.2 8 24V12L24 4Z" />
      <path d="M16 28V18h16v10M13 32h22M20 18v10m8-10v10" />
    </svg>
  );
}

function StepIndicator({ stage }: { readonly stage: string }) {
  const order = ["enterCode", "identity", "review", "authorizing", "connected", "complete"];
  const current = Math.max(0, order.indexOf(stage));
  const visibleStep = Math.min(current + 1, 5);
  return (
    <div className="step-indicator" aria-label={`Connection step ${visibleStep} of 5`}>
      <span>{visibleStep} of 5</span>
      <div className="step-track" aria-hidden="true">
        <span style={{ width: `${(visibleStep / 5) * 100}%` }} />
      </div>
    </div>
  );
}

function StatusIcon({ status }: { readonly status: "available" | "restricted" | "unavailable" }) {
  return <span className={`status-icon status-${status}`} aria-hidden="true" />;
}

export default function App() {
  const route = useMemo(() => {
    const parsed = parsePairingRoute(window.location.href);
    if (parsed.containsSensitiveQuery) window.history.replaceState(null, "", parsed.sanitizedPath);
    return parsed;
  }, []);

  const [state, dispatch] = useReducer(pairingReducer, {
    ...initialPairingState,
    code: route.initialCode,
  });
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [remaining, setRemaining] = useState(0);
  const client = useMemo(() => {
    if (provider === "api") {
      const origins = (import.meta.env.VITE_ALLOWED_AUTH_ORIGINS ?? "https://agent.robinhood.com")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean);
      return createApiPairingClient({
        apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? window.location.origin,
        allowedAuthorizationOrigins: origins,
        accountMode,
      });
    }
    return createMockPairingClient();
  }, []);

  useEffect(() => {
    if (route.callbackPairingId === null) return;
    setBusy(true);
    void client.getCompletedConnection(route.callbackPairingId)
      .then(({ session, receipt }) => {
        dispatch({ type: "RESTORED_CONNECTED", session, receipt });
        setAnnouncement("Broker connection completed and verified.");
      })
      .catch((error: unknown) => {
        dispatch({ type: "FAILED", message: error instanceof Error ? error.message : "Connection status could not be verified." });
      })
      .finally(() => setBusy(false));
  }, [client, route.callbackPairingId]);

  useEffect(() => {
    if (state.session === null) return;
    const update = () => {
      const seconds = secondsUntil(state.session?.expiresAt ?? "");
      setRemaining(seconds);
      if (seconds === 0) dispatch({ type: "EXPIRED" });
    };
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [state.session]);

  const submitCode = async (event: FormEvent) => {
    event.preventDefault();
    if (!isValidPairingCode(state.code)) return;
    setBusy(true);
    try {
      const session = await client.claim(state.code);
      dispatch({ type: "CODE_ACCEPTED", session });
      setAnnouncement("Pairing code accepted. Verify your identity to continue.");
    } catch (error) {
      dispatch({ type: "FAILED", message: error instanceof Error ? error.message : "Connection failed." });
    } finally {
      setBusy(false);
    }
  };

  const verifyIdentity = async () => {
    if (state.session === null) return;
    setBusy(true);
    try {
      await client.verifyIdentity(state.session.id);
      dispatch({ type: "IDENTITY_VERIFIED" });
      setAnnouncement("Identity verified. Review the connection before continuing.");
    } catch (error) {
      dispatch({ type: "FAILED", message: error instanceof Error ? error.message : "Identity verification failed." });
    } finally {
      setBusy(false);
    }
  };

  const cancelAndReset = async () => {
    const session = state.session;
    if (session === null) {
      dispatch({ type: "RESET" });
      return;
    }
    setBusy(true);
    try {
      await client.cancel(session.id);
      dispatch({ type: "RESET" });
      setAnnouncement("Pairing canceled. Enter a new code when you are ready.");
    } catch (error) {
      dispatch({ type: "FAILED", message: error instanceof Error ? error.message : "Pairing could not be canceled." });
    } finally {
      setBusy(false);
    }
  };

  const beginAuthorization = async () => {
    if (state.session === null) return;
    dispatch({ type: "AUTHORIZATION_STARTED" });
    setBusy(true);
    try {
      const result = await client.beginAuthorization(state.session.id);
      if (result.kind === "redirect") {
        window.location.assign(result.url);
        return;
      }
      dispatch({ type: "CONNECTION_CONFIRMED", receipt: result.receipt });
      setAnnouncement("Robinhood Agentic Account demo connection completed.");
    } catch (error) {
      dispatch({ type: "FAILED", message: error instanceof Error ? error.message : "Authorization failed." });
    } finally {
      setBusy(false);
    }
  };

  if (!configurationIsSafe) {
    return (
      <main className="center-shell">
        <section className="panel narrow" aria-labelledby="configuration-title">
          <TreasuryMark />
          <p className="eyebrow">Configuration stopped</p>
          <h1 id="configuration-title">Mock pairing is disabled outside Demo.</h1>
          <p>Set the pairing provider to <code>api</code> before deploying Paper or Live.</p>
        </section>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#connection-content">Skip to connection</a>
      <header className="site-header">
        <a className="brand" href="/" aria-label="Yield connection home">
          <TreasuryMark />
          <span><strong>WHOX</strong> Treasury</span>
        </a>
        <span className={`environment-badge ${isDemo ? "demo" : "secure"}`}>
          {isDemo ? "Demo connection" : `${deployment} environment`}
        </span>
      </header>

      <main id="connection-content" className="connection-layout">
        <aside id="connection-security" className="context-panel" aria-label="Connection security information">
          <p className="eyebrow">Secure browser connection</p>
          <h1>Connect without sharing credentials.</h1>
          <p>
            Pair Yield with a dedicated Robinhood Agentic Account. Authentication happens on the
            broker’s authorization page; WHOX never asks for your Robinhood password.
          </p>
          <ul className="trust-list">
            <li><span aria-hidden="true">01</span><div><strong>Single use</strong><small>The code stops working after a completed connection.</small></div></li>
            <li><span aria-hidden="true">02</span><div><strong>Short lived</strong><small>Expired sessions must be regenerated from the app.</small></div></li>
            <li><span aria-hidden="true">03</span><div><strong>Server protected</strong><small>Broker tokens never appear in this browser experience.</small></div></li>
          </ul>
          <p id="risk-disclosure" className="risk-note">
            Investing involves risk, including possible loss of principal. Automated strategies can make errors.
            Yield is not Robinhood and is not represented as endorsed by Robinhood.
          </p>
        </aside>

        <section className="panel flow-panel" aria-labelledby="flow-title">
          <StepIndicator stage={state.stage} />

          {(state.stage === "enterCode" || state.stage === "error") && (
            <div className="flow-step">
              <p className="eyebrow">Start pairing</p>
              <h2 id="flow-title">Enter the code from your app</h2>
              <p>Codes contain eight letters or numbers. They are not case sensitive.</p>
              {state.message !== null && <div className="alert error" role="alert">{state.message}</div>}
              <form onSubmit={submitCode} noValidate>
                <label htmlFor="pairing-code">Pairing code</label>
                <input
                  id="pairing-code"
                  className="code-input"
                  value={state.code}
                  onChange={(event) => dispatch({ type: "CODE_CHANGED", code: event.target.value })}
                  inputMode="text"
                  autoComplete="one-time-code"
                  autoCapitalize="characters"
                  spellCheck={false}
                  maxLength={9}
                  placeholder="XXXX-XXXX"
                  aria-describedby="pairing-help"
                  autoFocus
                />
                <p id="pairing-help" className="field-help">
                  {isDemo ? "Demo code: SAFE-482K. No brokerage account is contacted." : "An existing authenticated WHOX browser session is required. This page does not start sign-in."}
                </p>
                <button className="primary-button" type="submit" disabled={busy || !isValidPairingCode(state.code)}>
                  {busy ? "Checking securely…" : "Continue"}
                </button>
                {isDemo && state.code !== "SAFE-482K" && (
                  <button className="text-button" type="button" onClick={() => dispatch({ type: "CODE_CHANGED", code: "SAFE-482K" })}>
                    Use demo code
                  </button>
                )}
              </form>
            </div>
          )}

          {state.stage === "identity" && state.session !== null && (
            <div className="flow-step">
              <p className="eyebrow">Confirm identity</p>
              <h2 id="flow-title">Use the same WHOX account</h2>
              <p>Pairing belongs to <strong>{state.session.identityHint}</strong>. This step verifies an existing WHOX browser session; it does not start Sign in with Apple. If identity is not configured here, return to the app.</p>
              <div className="session-row">
                <span>Code <strong>{state.session.displayCode}</strong></span>
                <span className={remaining < 60 ? "urgent" : ""}>Expires in {formatCountdown(remaining)}</span>
              </div>
              <button className="primary-button" type="button" onClick={verifyIdentity} disabled={busy}>
                {busy ? "Verifying…" : isDemo ? "Continue with Demo Identity" : "Verify existing WHOX session"}
              </button>
              <button className="text-button" type="button" onClick={() => void cancelAndReset()} disabled={busy}>Cancel and use a different code</button>
            </div>
          )}

          {state.stage === "review" && state.session !== null && (
            <div className="flow-step">
              <p className="eyebrow">Review connection</p>
              <h2 id="flow-title">You’ll continue on Robinhood</h2>
              <p>Review the broker’s permissions before approving. WHOX only stores an encrypted server-side authorization and a masked account reference.</p>
              <dl className="review-list">
                <div><dt>Account mode</dt><dd>{state.session.accountMode}</dd></div>
                <div><dt>Pairing</dt><dd>{state.session.displayCode}</dd></div>
                <div><dt>Session</dt><dd>Single-use · {formatCountdown(remaining)} remaining</dd></div>
                <div><dt>Live trading</dt><dd>{isDemo ? "Disabled — demo simulation only" : "Subject to every server release gate"}</dd></div>
              </dl>
              <div className="alert info" role="note">Do not continue if the broker page opens on an unfamiliar domain.</div>
              <button className="primary-button" type="button" onClick={beginAuthorization}>Begin secure authorization</button>
              <button className="text-button" type="button" onClick={() => void cancelAndReset()} disabled={busy}>Cancel pairing</button>
            </div>
          )}

          {state.stage === "authorizing" && (
            <div className="flow-step centered" aria-busy="true">
              <span className="progress-ring" aria-hidden="true" />
              <p className="eyebrow">Authorization in progress</p>
              <h2 id="flow-title">Securing the connection…</h2>
              <p>{isDemo ? "Completing a local demo handshake. No broker request is sent." : "Waiting for the authorization server."}</p>
            </div>
          )}

          {state.stage === "connected" && state.receipt !== null && (
            <div className="flow-step">
              <span className="success-mark" aria-hidden="true">✓</span>
              <p className="eyebrow success-text">Connected</p>
              <h2 id="flow-title">Account connection verified</h2>
              <p>{state.receipt.accountType}. Only the masked identifier is shown here.</p>
              <dl className="review-list">
                <div><dt>Account</dt><dd>{state.receipt.maskedAccountIdentifier}</dd></div>
                <div>
                  <dt>Last sync</dt>
                  <dd>
                    {state.receipt.lastSuccessfulSync === undefined
                      ? "Account hydration pending"
                      : new Date(state.receipt.lastSuccessfulSync).toLocaleString()}
                  </dd>
                </div>
              </dl>
              <h3>Available capabilities</h3>
              <ul className="capability-list">
                {(state.receipt.capabilities.length === 0
                  ? [{
                      label: "Broker capability sync",
                      status: "restricted" as const,
                      detail: "Authorization is complete. Trading remains unavailable until the first verified account sync finishes.",
                    }]
                  : state.receipt.capabilities).map((capability) => (
                  <li key={capability.label}>
                    <StatusIcon status={capability.status} />
                    <div><strong>{capability.label}</strong><small>{capability.detail}</small></div>
                  </li>
                ))}
              </ul>
              <div className="alert info" role="note">A subscription never grants broker trading permission. Broker capability and risk checks still apply.</div>
              <button className="primary-button" type="button" onClick={() => dispatch({ type: "FINISHED" })}>Continue</button>
            </div>
          )}

          {state.stage === "complete" && (
            <div className="flow-step centered">
              <span className="success-mark" aria-hidden="true">✓</span>
              <p className="eyebrow success-text">All set</p>
              <h2 id="flow-title">Return to Yield</h2>
              <p>The app will receive the connection status through its secure status channel. You may close this tab.</p>
              <button
                className="secondary-button"
                type="button"
                onClick={() => {
                  window.close();
                  window.setTimeout(() => window.location.replace("about:blank"), 100);
                }}
              >
                Clear and close this page
              </button>
            </div>
          )}

          {state.stage === "expired" && (
            <div className="flow-step">
              <p className="eyebrow">Session expired</p>
              <h2 id="flow-title">Create a new pairing code</h2>
              <p>This code is no longer valid. Return to Yield, generate a new code, then enter it here.</p>
              <button className="primary-button" type="button" onClick={() => dispatch({ type: "RESET" })}>Enter a new code</button>
            </div>
          )}
        </section>
      </main>

      <footer>
        <span>Yield · Automated Strategy Control</span>
        <nav aria-label="Page information"><a href="#connection-security">Security</a><a href="#risk-disclosure">Risk disclosure</a></nav>
      </footer>
      <p className="sr-only" aria-live="polite">{announcement}</p>
    </div>
  );
}
