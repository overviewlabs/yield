# Deterministic risk engine

Risk checks are pure, versioned server functions over a proposal and current verified snapshots. User values may only tighten platform caps. Every result records check ID/version, observed value, effective limit, pass/reject/escalate, reason code, snapshot timestamps, and proposal/config versions.

## Evaluation order

1. Environment and all applicable release gates.
2. User/eligibility/legal/security status and current subscription entitlement.
3. Strategy/agent version, approval mode, broker connection/capability, and verified Agentic Account binding.
4. Current account/position/reservation/market-session/freshness/tradability state.
5. User/platform order, position, allocation, concentration, buying-power, daily-loss, drawdown, turnover, count, exclusion, event, cooldown, liquidity, and deviation limits.
6. Instrument-specific rules and calculable maximum loss.
7. Broker review warnings and unexpired user approval.

After approval and immediately before placement, re-run all volatile checks. Any changed position, quote, buying power, entitlement, limits, capability, connection, market session, or approval causes re-review/rejection rather than silent adjustment.

## Instrument defaults

Equity starts long-only, no short sale or margin-dependent assumption, liquid/tradable securities, and deterministic exit behavior. Options start with no naked/unlimited-loss structure, no 0DTE, limit orders, known maximum loss, permission/collateral/coverage checks, strict contract/exposure/DTE/liquidity/spread/event caps, and independent expiration monitoring. A subscription never supplies broker approval.

## Halts

A user or system risk halt stops new entries while monitoring, expiration jobs, and reconciliation continue. User-reviewed risk-reducing exits may proceed only through the normal broker review, approval, and risk boundary. Reactivation requires remediation, current snapshots, authentication, authorization, and an audited event; it never happens solely because a metric fell below threshold.

Tests cover boundary equality, tightened limits, monetary precision, maximum loss/payoff, position sizing, drawdown, reservations/conflicts, stale/clock behavior, calendar/session rules, duplicate/race handling, and property tests proving the platform maximum cannot be loosened.
