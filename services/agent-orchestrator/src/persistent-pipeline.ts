import { createHash } from "node:crypto";
import { evaluateAgentAvailability, getAgentDefinition, type AgentDefinition } from "@whox/agent-definitions";
import {
  DomainError,
  type Entitlements,
  type ProposalStatus,
  type ReleaseGates,
  type RiskPolicy,
  type TradeProposal
} from "@whox/contracts";
import { evaluateRisk, proposalFingerprint, validateUserPolicyAgainstPlatform, type RiskContext } from "@whox/risk-schemas";
import { Pool, type PoolClient } from "pg";
import { createProposalAggregate, transitionProposal, type ProposalAggregate } from "./index.js";
import {
  hermesResearchForSymbol,
  hermesResearchRequestId,
  parseSanitizedHermesResearchArtifact,
  type HermesSymbolResearchAnalysis,
  type SanitizedHermesResearchArtifact
} from "./hermes-research.js";
import { parseAgentRunJobPayload, type ScheduledPlanCycleContext } from "./plan-cycle.js";

const REQUIRED_LEGAL_DOCUMENTS = Object.freeze(["terms", "privacy", "ai-risk"] as const);
const CAPABILITY_MAX_AGE_SECONDS = 300;
const PLAN_RESEARCH_MAX_AGE_SECONDS = 300;
const CLOCK_SKEW_MILLISECONDS = 5_000;
const PROPOSAL_LIFETIME_MS = 5 * 60_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,14}$/;
const SECTOR_MAX_LENGTH = 100;

export interface PersistentAgentPipelineOptions {
  readonly approvedMarketDataProviders: readonly string[];
  readonly releaseGates: ReleaseGates;
  readonly mode: "paper";
  readonly clock?: () => string;
}

export interface PersistentAgentRunCommand {
  readonly userId: string;
  readonly userAgentId: string;
  readonly runIdempotencyKey: string;
  readonly correlationId: string;
  readonly planCycle?: ScheduledPlanCycleContext;
}

export interface PersistentAgentRunResult {
  readonly runId: string;
  readonly userAgentId: string;
  readonly status: "completed" | "failed";
  readonly proposalId?: string;
  readonly proposalStatus?: ProposalStatus;
  readonly errorCode?: string;
}

interface ExistingRunRow {
  id: string;
  user_id: string;
  user_agent_id: string;
  status: string;
  error_code: string | null;
}

interface AgentBindingRow {
  user_id: string;
  user_status: "active" | "suspended" | "closed";
  account_mode: "demo" | "paper" | "live";
  user_agent_id: string;
  user_agent_status: string;
  user_agent_environment: "demo" | "paper" | "live";
  allocation_limit: string;
  approval_mode: "observe" | "confirm_every_trade" | "automatic_within_limits";
  configuration_id: string | null;
  configuration: unknown;
  agent_version_id: string;
  agent_version: string;
  agent_version_status: string;
  required_plan_key: string;
  deterministic_strategy_version: string;
  persisted_definition: unknown;
  agent_definition_id: string;
  agent_key: string;
  broker_account_id: string;
  verified_for_trading_at: Date | null;
  account_active: boolean;
  is_agentic_account: boolean;
  connection_id: string;
  connection_status: string;
  connection_last_sync_at: Date | null;
  connection_revoked_at: Date | null;
}

interface PolicyRow {
  id: string;
  user_id: string;
  version: number;
  limits: unknown;
  exclusions: unknown;
  effective_at: Date;
}

interface EligibilityRow {
  adviser_client_classification: "self_directed" | "adviser_client";
}

interface PortfolioRow {
  id: string;
  total_value: string;
  buying_power: string;
  source_timestamp: Date;
  valid_until: Date;
  sync_completed_at: Date;
  snapshot_fingerprint: string;
}

interface PositionRow {
  symbol: string;
  instrument_type: "equity" | "option";
  quantity: string;
  market_value: string;
  details: unknown;
}

interface QuoteRow {
  id: string;
  provider: string;
  payload: unknown;
  source_timestamp: Date;
  received_at: Date;
}

interface OperationalMetricsRow {
  own_reservations: string;
  other_reservations: string;
  trades_today: string;
  turnover_notional: string;
  duplicate_proposal: boolean;
  duplicate_open_order: boolean;
  peak_value: string | null;
  opening_value: string | null;
  active_risk_halt: boolean;
  active_security_halt: boolean;
  active_system_incident: boolean;
}

interface PlanCycleResearchRow {
  plan_cycle_id: string;
  evaluation_as_of: Date;
  strategy_version: string;
  artifact_id: string;
  decision_sha256: string;
  context_sha256: string;
  request_sha256: string;
  provider_id: string;
  model_id: string;
  source_as_of: Date;
  created_at: Date;
  sanitized_decision: unknown;
}

interface BoundPlanResearch {
  readonly row: PlanCycleResearchRow;
  readonly artifact: SanitizedHermesResearchArtifact;
  readonly symbolResearch: HermesSymbolResearchAnalysis;
}

interface ParsedQuote {
  readonly id: string;
  readonly provider: string;
  readonly sourceTimestamp: string;
  readonly bid: number;
  readonly ask: number;
  readonly last: number;
  readonly tradable: boolean;
  readonly fractionalSupported: boolean;
  readonly liquiditySufficient: boolean;
  readonly marketSession: "open" | "extended" | "closed";
  readonly volatilityHalt: boolean;
  readonly tradingHalt: boolean;
  readonly corporateActionRestricted: boolean;
  readonly earningsWindow: boolean;
  readonly sector: string;
  readonly brokerWarningSeverity: "none" | "informational" | "blocking";
  readonly rawPayload: Readonly<Record<string, unknown>>;
}

interface StrategyConfiguration {
  readonly symbol: string;
  readonly targetOrderAmount: number;
}

interface RunInputs {
  readonly definition: AgentDefinition;
  readonly policy: RiskPolicy;
  readonly entitlements: Entitlements;
  readonly portfolio: PortfolioRow;
  readonly positions: readonly PositionRow[];
  readonly quote: ParsedQuote;
  readonly configuration: StrategyConfiguration;
  readonly legalConsentsCurrent: boolean;
  readonly metrics: OperationalMetricsRow;
  readonly capabilities: ReadonlySet<string>;
}

/**
 * Transactional, deterministic Paper pipeline. It deliberately implements only
 * Foundation Equity v1; every unsupported strategy or unproven input fails
 * closed and is recorded on the durable run.
 */
export class PostgresAgentPipeline {
  readonly #pool: Pool;
  readonly #providers: readonly string[];
  readonly #releaseGates: ReleaseGates;
  readonly #mode: "paper";
  readonly #clock: () => string;

  public constructor(databaseUrl: string, options: PersistentAgentPipelineOptions) {
    if (databaseUrl.trim() === "") throw new TypeError("DATABASE_URL is required");
    const providers = [...new Set(options.approvedMarketDataProviders.map((value) => value.trim()).filter(Boolean))];
    if (providers.length === 0 || providers.some((value) => !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value))) {
      throw new DomainError(
        "APPROVED_MARKET_DATA_PROVIDERS_REQUIRED",
        "Paper agent runs require an explicit approved market-data provider allowlist",
        500
      );
    }
    this.#pool = new Pool({ connectionString: databaseUrl, application_name: "whox-agent-pipeline", max: 6 });
    this.#providers = Object.freeze(providers);
    this.#releaseGates = options.releaseGates;
    this.#mode = options.mode;
    this.#clock = options.clock ?? (() => new Date().toISOString());
  }

  public async run(command: PersistentAgentRunCommand): Promise<PersistentAgentRunResult> {
    assertCommand(command);
    const planCycle = command.planCycle;
    if (planCycle === undefined) {
      throw new DomainError(
        "PLAN_CYCLE_REQUIRED",
        "Paper agent evaluations require an immutable shared plan-cycle research artifact",
        422
      );
    }
    const now = this.#clock();
    if (!Number.isFinite(Date.parse(now))) throw new TypeError("Agent pipeline clock must return an ISO-8601 timestamp");
    const persistedIdempotencyKey = `agent-run:${command.userAgentId}:${command.runIdempotencyKey}`;

    return this.#transaction(async (client) => {
      await client.query(`SELECT set_config('app.user_id',$1,true)`, [command.userId]);
      const existing = await this.#existingRun(client, persistedIdempotencyKey);
      if (existing !== undefined) return this.#replayResult(client, existing, command);

      const binding = await this.#loadBinding(client, command.userId, command.userAgentId, now);
      const planResearch = await this.#validatePlanCycleResearch(
        client,
        command.userId,
        planCycle,
        binding,
        now
      );
      const runId = stableUuid(`run:${persistedIdempotencyKey}`);
      const inserted = await client.query(
        `INSERT INTO agent_runs(id,user_id,user_agent_id,status,idempotency_key,started_at,strategy_version)
         VALUES($1,$2,$3,'started',$4,$5::timestamptz,$6)
         ON CONFLICT(idempotency_key) DO NOTHING`,
        [runId, command.userId, command.userAgentId, persistedIdempotencyKey, now, binding.deterministic_strategy_version]
      );
      if (inserted.rowCount !== 1) {
        const raced = await this.#existingRun(client, persistedIdempotencyKey);
        if (raced === undefined) throw new DomainError("AGENT_RUN_IDEMPOTENCY_CONFLICT", "Agent run idempotency ownership conflicts", 409);
        return this.#replayResult(client, raced, command);
      }

      try {
        return await this.#executeRun(client, command, binding, runId, now, planResearch);
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        await client.query(
          `UPDATE agent_runs SET status='failed',completed_at=$3::timestamptz,error_code=$4,
             structured_outcome=$5::jsonb WHERE id=$1 AND user_id=$2`,
          [runId, command.userId, now, error.code, JSON.stringify({ outcome: "failed_closed", errorCode: error.code })]
        );
        return Object.freeze({ runId, userAgentId: command.userAgentId, status: "failed", errorCode: error.code });
      }
    });
  }

  public async close(): Promise<void> {
    await this.#pool.end();
  }

  async #executeRun(
    client: PoolClient,
    command: PersistentAgentRunCommand,
    binding: AgentBindingRow,
    runId: string,
    now: string,
    planResearch: PlanCycleResearchRow
  ): Promise<PersistentAgentRunResult> {
    const definition = this.#validateBinding(binding, now);
    const configuration = parseConfiguration(binding.configuration);
    const researchArtifact = parseSanitizedHermesResearchArtifact(planResearch.sanitized_decision);
    if (
      researchArtifact.requestId !== hermesResearchRequestId(planResearch.plan_cycle_id) ||
      researchArtifact.requestDigest !== planResearch.request_sha256
    ) {
      throw new DomainError("PLAN_RESEARCH_ARTIFACT_INVALID", "Plan research provenance is not bound to its cycle", 500);
    }
    const boundPlanResearch: BoundPlanResearch = Object.freeze({
      row: planResearch,
      artifact: researchArtifact,
      symbolResearch: hermesResearchForSymbol(researchArtifact, configuration.symbol)
    });
    const capabilities = await this.#loadCapabilities(client, binding.connection_id, now);
    const eligibility = await this.#requireCurrentEligibility(client, command.userId, now);
    await this.#requireCurrentRiskAssessment(client, command.userId, now);
    const entitlements = await this.#loadEntitlements(client, command.userId, now);
    const availability = evaluateAgentAvailability(definition, this.#mode, entitlements, capabilities);
    if (!availability.available || !entitlements.agentCatalog.includes(definition.agentId)) {
      throw new DomainError(
        "AGENT_UNAVAILABLE",
        "The current subscription, release, account mode, or broker capabilities do not permit this agent",
        403,
        { reasons: [...availability.reasons] }
      );
    }
    const activeAgents = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM user_agents
       WHERE user_id=$1 AND deleted_at IS NULL AND status IN ('monitoring','waiting_approval','automatic')`,
      [command.userId]
    );
    if (Number(activeAgents.rows[0]?.count ?? Number.POSITIVE_INFINITY) > entitlements.maximumActiveAgents) {
      throw new DomainError("ACTIVE_AGENT_LIMIT_EXCEEDED", "The current subscription active-agent limit is exceeded", 403);
    }

    const policy = await this.#loadPolicy(client, command.userId, now);
    const portfolio = await this.#loadPortfolio(
      client,
      command.userId,
      binding.broker_account_id,
      binding.connection_id,
      policy,
      now
    );
    if (
      binding.connection_last_sync_at === null ||
      binding.connection_last_sync_at.getTime() < portfolio.source_timestamp.getTime()
    ) {
      throw new DomainError(
        "AUTHORITATIVE_ACCOUNT_SNAPSHOT_REQUIRED",
        "The connected broker sync must attest the current Agentic Account snapshot",
        503
      );
    }
    const positions = await this.#loadPositions(client, command.userId, portfolio.id);
    const quote = await this.#loadQuote(client, configuration.symbol, policy, now);
    const legalConsentsCurrent = await this.#legalConsentsCurrent(
      client,
      command.userId,
      now,
      entitlements.optionsTrading,
      eligibility.adviser_client_classification
    );
    const metrics = await this.#loadMetrics(
      client,
      command.userId,
      command.userAgentId,
      binding.broker_account_id,
      binding.connection_id,
      configuration.symbol,
      now
    );
    const inputs: RunInputs = Object.freeze({
      definition,
      policy,
      entitlements,
      portfolio,
      positions,
      quote,
      configuration,
      legalConsentsCurrent,
      metrics,
      capabilities
    });

    if (quote.last < 5) {
      return this.#completeNoAction(client, command, binding, runId, now, configuration.symbol, "PENNY_STOCK_RESTRICTED");
    }

    const proposal = this.#buildProposal(command, binding, inputs, runId, now);
    let aggregate = createProposalAggregate(proposal, now);
    const context = this.#riskContext(command, binding, inputs, proposal, now);
    const risk = evaluateRisk(proposal, policy, context);
    aggregate = advance(aggregate, "ANALYZED", "DETERMINISTIC_ANALYSIS_COMPLETED", command.correlationId, eventTime(now, 1), 1);
    aggregate = advance(aggregate, "SCHEMA_VALIDATED", "PROPOSAL_SCHEMA_VALIDATED", command.correlationId, eventTime(now, 2), 2);
    if (!risk.passed) {
      aggregate = advance(aggregate, "RISK_REJECTED", "RISK_POLICY_REJECTED", command.correlationId, eventTime(now, 3), 3);
    } else {
      aggregate = advance(aggregate, "RISK_CHECKED", "RISK_POLICY_PASSED", command.correlationId, eventTime(now, 3), 3);
      this.#paperBrokerReview(proposal, inputs);
      aggregate = advance(aggregate, "BROKER_REVIEWED", "PAPER_PRETRADE_REVIEW_PASSED", command.correlationId, eventTime(now, 4), 4, {
        reviewSource: "authoritative-paper-pretrade-adapter"
      });
      if (binding.approval_mode === "confirm_every_trade") {
        aggregate = advance(aggregate, "AWAITING_USER_APPROVAL", "AUTHENTICATED_USER_APPROVAL_REQUIRED", command.correlationId, eventTime(now, 5), 5);
      } else if (binding.approval_mode === "automatic_within_limits") {
        if (
          binding.user_agent_status !== "automatic" ||
          !entitlements.automaticMode ||
          !this.#releaseGates.AUTONOMOUS_MODE_ENABLED
        ) {
          throw new DomainError(
            "AUTOMATIC_APPROVAL_NOT_AUTHORIZED",
            "Automatic approval requires current agent state, entitlement, and the server release gate",
            403
          );
        }
        const automaticApprovalTime = eventTime(now, 5);
        aggregate = transitionProposal(aggregate, {
          toStatus: "APPROVED",
          actorType: "worker",
          actorId: "agent-orchestrator",
          reasonCode: "AUTOMATIC_SERVER_GATE_APPROVED",
          correlationId: command.correlationId,
          idempotencyKey: `${proposal.proposalId}:state:5`,
          occurredAt: automaticApprovalTime,
          automaticAuthorization: {
            source: "server-release-gates",
            autonomousModeEnabled: true,
            authorizedAt: automaticApprovalTime
          }
        });
      }
    }

    await this.#persistProposal(client, command, binding, runId, proposal, aggregate, risk, inputs, boundPlanResearch, now);
    const outcome = risk.passed
      ? binding.approval_mode === "observe"
        ? "observed_proposal"
        : binding.approval_mode === "confirm_every_trade"
          ? "awaiting_user_approval"
          : "automatically_approved"
      : "risk_rejected";
    await client.query(
      `UPDATE agent_runs SET status='completed',completed_at=$3::timestamptz,error_code=NULL,
         data_sources=$4::jsonb,structured_outcome=$5::jsonb WHERE id=$1 AND user_id=$2`,
      [
        runId,
        command.userId,
        aggregate.updatedAt,
        JSON.stringify([
          { type: "portfolio", referenceId: portfolio.id, observedAt: portfolio.source_timestamp.toISOString() },
          { type: "quote", referenceId: quote.id, source: quote.provider, observedAt: quote.sourceTimestamp },
          { type: "agent_configuration", referenceId: binding.configuration_id },
          {
            type: "plan_research",
            referenceId: planResearch.artifact_id,
            payloadDigest: planResearch.decision_sha256,
            observedAt: planResearch.evaluation_as_of.toISOString()
          }
        ]),
        JSON.stringify({
          outcome,
          proposalId: proposal.proposalId,
          proposalStatus: aggregate.status,
          riskPassed: risk.passed,
          planCycleId: planResearch.plan_cycle_id
        })
      ]
    );
    return Object.freeze({
      runId,
      userAgentId: command.userAgentId,
      status: "completed",
      proposalId: proposal.proposalId,
      proposalStatus: aggregate.status
    });
  }

  #validateBinding(binding: AgentBindingRow, now: string): AgentDefinition {
    const nowInstant = Date.parse(now);
    const verificationTime = binding.verified_for_trading_at?.getTime() ?? Number.NaN;
    const syncTime = binding.connection_last_sync_at?.getTime() ?? Number.NaN;
    if (
      binding.user_status !== "active" ||
      binding.account_mode !== this.#mode ||
      binding.user_agent_environment !== this.#mode ||
      !["monitoring", "waiting_approval", "automatic"].includes(binding.user_agent_status)
    ) {
      throw new DomainError("AGENT_BINDING_INACTIVE", "The user and agent must be active in the Paper environment", 403);
    }
    if (
      !binding.account_active ||
      !binding.is_agentic_account ||
      binding.verified_for_trading_at === null ||
      binding.connection_status !== "connected" ||
      binding.connection_revoked_at !== null ||
      binding.connection_last_sync_at === null ||
      !Number.isFinite(verificationTime) ||
      !Number.isFinite(syncTime) ||
      verificationTime > nowInstant + 5_000 ||
      syncTime > nowInstant + 5_000 ||
      nowInstant - syncTime > CAPABILITY_MAX_AGE_SECONDS * 1_000
    ) {
      throw new DomainError("AGENTIC_ACCOUNT_BINDING_INVALID", "A connected, verified Agentic Account is required", 403);
    }
    if (binding.configuration_id === null) {
      throw new DomainError("CURRENT_AGENT_CONFIGURATION_REQUIRED", "A current persisted agent configuration is required", 409);
    }
    if (binding.agent_key !== "foundation-equity" || binding.agent_version !== "1.0.0") {
      throw new DomainError(
        "DETERMINISTIC_STRATEGY_UNIMPLEMENTED",
        "Only Foundation Equity v1 has an implemented deterministic server pipeline",
        503
      );
    }
    const definition = getAgentDefinition(binding.agent_key, binding.agent_version);
    if (
      definition === undefined ||
      binding.agent_version_status !== "paper" ||
      definition.deterministicStrategyVersion !== binding.deterministic_strategy_version
    ) {
      throw new DomainError("AGENT_VERSION_BINDING_INVALID", "The current catalog and persisted agent version do not match", 409);
    }
    const persisted = record(binding.persisted_definition);
    const modes = persisted.permittedAccountModes;
    const instruments = persisted.instruments;
    if (
      !Array.isArray(modes) ||
      !modes.includes(this.#mode) ||
      !Array.isArray(instruments) ||
      !instruments.includes("equity")
    ) {
      throw new DomainError("AGENT_VERSION_BINDING_INVALID", "The persisted agent definition does not permit Paper equity proposals", 409);
    }
    return definition;
  }

  #buildProposal(
    command: PersistentAgentRunCommand,
    binding: AgentBindingRow,
    inputs: RunInputs,
    runId: string,
    now: string
  ): TradeProposal {
    const { policy, portfolio, positions, quote, configuration, definition } = inputs;
    const accountValue = numeric(portfolio.total_value, "portfolio total value");
    const currentAllocated = positions.reduce((total, position) => total + Math.abs(numeric(position.market_value, "position market value")), 0);
    const fractional = policy.fractionalSharesPermitted && quote.fractionalSupported;
    const rawQuantity = configuration.targetOrderAmount / quote.ask;
    const quantity = fractional ? Math.floor(rawQuantity * 1_000_000) / 1_000_000 : Math.floor(rawQuantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new DomainError("ORDER_AMOUNT_BELOW_MINIMUM", "Configured order amount cannot purchase a supported share quantity", 409);
    }
    const notional = round(quantity * quote.ask, 6);
    const oldestDataTimestamp = new Date(
      Math.min(Date.parse(quote.sourceTimestamp), portfolio.source_timestamp.getTime())
    ).toISOString();
    return Object.freeze({
      proposalId: stableUuid(`proposal:${runId}`),
      userId: command.userId,
      accountId: binding.broker_account_id,
      agentDefinitionId: binding.agent_definition_id,
      agentVersion: binding.agent_version,
      environment: this.#mode,
      instrumentType: "equity",
      symbol: configuration.symbol,
      optionLegs: Object.freeze([]),
      side: "buy",
      quantity,
      notionalEstimate: notional,
      orderType: "limit",
      limitPrice: quote.ask,
      timeInForce: "day",
      strategyType: "foundation_equity",
      entryReason: "Versioned Foundation Equity allocation rule selected an eligible configured instrument",
      exitPlan: "Rebalance when the deterministic allocation rule no longer supports the position",
      invalidationCondition: "The instrument becomes ineligible, untradable, halted, or exceeds a risk limit",
      dataTimestamp: oldestDataTimestamp,
      quoteTimestamp: quote.sourceTimestamp,
      maximumLoss: notional,
      breakevens: Object.freeze([]),
      estimatedPortfolioAllocationAfter: Math.min(1, round((currentAllocated + notional) / Math.max(accountValue, 1), 8)),
      riskAmount: notional,
      confidenceCategoryWithoutProbabilityClaims: "moderate",
      requiredApprovalMode: binding.approval_mode,
      expirationTimestamp: new Date(Date.parse(now) + PROPOSAL_LIFETIME_MS).toISOString(),
      evidenceReferences: Object.freeze([
        { kind: "quote" as const, source: quote.provider, observedAt: quote.sourceTimestamp, referenceId: quote.id },
        { kind: "portfolio" as const, source: "broker-portfolio-store", observedAt: portfolio.source_timestamp.toISOString(), referenceId: portfolio.id },
        { kind: "strategy_rule" as const, source: definition.deterministicStrategyVersion, observedAt: now, referenceId: binding.configuration_id! }
      ]),
      warnings: Object.freeze(["Paper environment only; no live order is authorized by this proposal"]),
      deterministicStrategyVersion: binding.deterministic_strategy_version
    });
  }

  #riskContext(
    command: PersistentAgentRunCommand,
    binding: AgentBindingRow,
    inputs: RunInputs,
    proposal: TradeProposal,
    now: string
  ): RiskContext {
    const { policy, entitlements, portfolio, positions, quote, legalConsentsCurrent, metrics } = inputs;
    const accountValue = numeric(portfolio.total_value, "portfolio total value");
    const buyingPower = numeric(portfolio.buying_power, "portfolio buying power");
    const sector = quote.sector.toUpperCase();
    const equityPositions = positions.filter((position) => position.instrument_type === "equity");
    const currentAllocatedValue = equityPositions.reduce(
      (total, position) => total + Math.abs(numeric(position.market_value, "position market value")),
      0
    );
    const targetPositions = equityPositions.filter((position) => position.symbol.toUpperCase() === proposal.symbol);
    const currentPositionValue = targetPositions.reduce(
      (total, position) => total + Math.max(0, numeric(position.market_value, "target position market value")),
      0
    );
    const currentHeldQuantity = targetPositions.reduce(
      (total, position) => total + Math.max(0, numeric(position.quantity, "target position quantity")),
      0
    );
    const currentSectorValue = equityPositions
      .filter((position) => authoritativeSector(record(position.details).sector, "position sector").toUpperCase() === sector)
      .reduce((total, position) => total + Math.max(0, numeric(position.market_value, "sector market value")), 0);
    const peakValue = metrics.peak_value === null ? accountValue : numeric(metrics.peak_value, "portfolio peak value");
    const openingValue = metrics.opening_value === null ? accountValue : numeric(metrics.opening_value, "opening portfolio value");
    return Object.freeze({
      now,
      releaseGates: this.#releaseGates,
      userStatus: binding.user_status,
      currentLegalConsents: legalConsentsCurrent,
      entitlements,
      accountConnectionHealthy: true,
      verifiedAgenticAccountId: binding.broker_account_id,
      strategyEnabled: true,
      agentVersionEnabled: true,
      tradingPermission: binding.verified_for_trading_at !== null,
      marketSession: quote.marketSession,
      criticalServicesHealthy: !metrics.active_system_incident,
      securityHalt: metrics.active_security_halt,
      accountValue,
      buyingPower,
      reservedBuyingPower: numeric(metrics.own_reservations, "own capital reservations"),
      currentAllocatedValue,
      currentPositionValue,
      currentHeldQuantity,
      currentSectorValue,
      openPositionCount: equityPositions.filter((position) => numeric(position.quantity, "position quantity") !== 0).length,
      dailyLoss: Math.max(0, openingValue - accountValue),
      drawdownRatio: peakValue > 0 ? Math.max(0, (peakValue - accountValue) / peakValue) : 1,
      agentAllocatedValue: currentAllocatedValue,
      agentAllocationLimit: numeric(binding.allocation_limit, "agent allocation limit") * accountValue,
      otherAgentReservations: numeric(metrics.other_reservations, "other agent reservations"),
      duplicateProposal: metrics.duplicate_proposal,
      duplicateOpenOrder: metrics.duplicate_open_order,
      symbolSector: quote.sector,
      tradable: quote.tradable,
      fractionalSupported: quote.fractionalSupported,
      liquiditySufficient: quote.liquiditySufficient,
      volatilityHalt: quote.volatilityHalt,
      tradingHalt: quote.tradingHalt,
      corporateActionRestricted: quote.corporateActionRestricted,
      earningsWindow: quote.earningsWindow,
      cooldownActive: metrics.active_risk_halt,
      tradesToday: Number(metrics.trades_today),
      turnoverToday: numeric(metrics.turnover_notional, "daily turnover") / Math.max(accountValue, 1),
      accountSnapshotTimestamp: portfolio.source_timestamp.toISOString(),
      quotePrice: quote.last,
      expectedExecutionPrice: quote.ask,
      brokerWarningSeverity: quote.brokerWarningSeverity,
      approvalExpiresAt: proposal.expirationTimestamp
    });
  }

  #paperBrokerReview(proposal: TradeProposal, inputs: RunInputs): void {
    if (
      !inputs.capabilities.has("review_equity_order") ||
      proposal.orderType !== "limit" ||
      proposal.limitPrice !== inputs.quote.ask ||
      inputs.quote.brokerWarningSeverity === "blocking"
    ) {
      throw new DomainError("PAPER_BROKER_REVIEW_REJECTED", "The authoritative Paper pre-trade review rejected the proposal", 409);
    }
  }

  async #persistProposal(
    client: PoolClient,
    command: PersistentAgentRunCommand,
    binding: AgentBindingRow,
    runId: string,
    proposal: TradeProposal,
    aggregate: ProposalAggregate,
    risk: ReturnType<typeof evaluateRisk>,
    inputs: RunInputs,
    planResearch: BoundPlanResearch,
    now: string
  ): Promise<void> {
    const proposalKey = `proposal:${runId}`;
    await client.query(
      `INSERT INTO agent_run_candidates(id,agent_run_id,user_id,symbol,decision,rejection_codes,structured_rationale)
       VALUES($1,$2,$3,$4,$5,$6::text[],$7::jsonb)`,
      [
        stableUuid(`candidate:${runId}`),
        runId,
        command.userId,
        proposal.symbol,
        risk.passed ? "proposed" : "risk_rejected",
        risk.checks.filter((check) => !check.passed && check.severity === "blocking").map((check) => check.code),
        JSON.stringify({
          strategyVersion: proposal.deterministicStrategyVersion,
          deterministic: true,
          hermesResearch: {
            authority: "research_only",
            artifactId: planResearch.row.artifact_id,
            artifactDigest: planResearch.row.decision_sha256,
            requestId: planResearch.artifact.requestId,
            responseId: planResearch.artifact.responseId,
            model: planResearch.row.model_id,
            symbol: planResearch.symbolResearch.symbol,
            assessment: planResearch.symbolResearch.assessment,
            summary: planResearch.symbolResearch.summary,
            riskFactors: planResearch.symbolResearch.riskFactors,
            dataLimitations: planResearch.symbolResearch.dataLimitations
          }
        })
      ]
    );
    await client.query(
      `INSERT INTO trade_proposals(id,user_id,broker_account_id,agent_run_id,agent_version_id,environment,status,version,
         symbol,instrument_type,proposal,proposal_fingerprint,idempotency_key,expires_at,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6::app_environment,$7::proposal_status,$8,$9,'equity',$10::jsonb,$11,$12,$13::timestamptz,$14::timestamptz,$15::timestamptz)`,
      [
        proposal.proposalId,
        command.userId,
        binding.broker_account_id,
        runId,
        binding.agent_version_id,
        this.#mode,
        aggregate.status,
        aggregate.version,
        proposal.symbol,
        JSON.stringify(proposal),
        proposalFingerprint(proposal),
        proposalKey,
        proposal.expirationTimestamp,
        now,
        aggregate.updatedAt
      ]
    );
    const evidence = [
      {
        type: "quote",
        source: inputs.quote.provider,
        reference: inputs.quote.id,
        observedAt: inputs.quote.sourceTimestamp,
        digest: digest(inputs.quote.rawPayload)
      },
      {
        type: "portfolio",
        source: "broker-portfolio-store",
        reference: inputs.portfolio.id,
        observedAt: inputs.portfolio.source_timestamp.toISOString(),
        digest: digest({ totalValue: inputs.portfolio.total_value, buyingPower: inputs.portfolio.buying_power })
      },
      {
        type: "strategy_rule",
        source: proposal.deterministicStrategyVersion,
        reference: binding.configuration_id!,
        observedAt: now,
        digest: digest(binding.configuration)
      },
      {
        type: "model_research",
        source: `${planResearch.row.provider_id}:${planResearch.row.model_id}`,
        reference: planResearch.row.artifact_id,
        observedAt: planResearch.row.source_as_of.toISOString(),
        digest: planResearch.row.decision_sha256
      },
      {
        type: "broker_review",
        source: "authoritative-paper-pretrade-adapter",
        reference: binding.connection_id,
        observedAt: now,
        digest: digest({ capability: "review_equity_order", accepted: true, limitPrice: proposal.limitPrice })
      }
    ];
    for (const item of evidence) {
      await client.query(
        `INSERT INTO trade_proposal_evidence(proposal_id,user_id,evidence_type,source,source_reference,observed_at,payload_digest)
         VALUES($1,$2,$3,$4,$5,$6::timestamptz,$7)`,
        [proposal.proposalId, command.userId, item.type, item.source, item.reference, item.observedAt, item.digest]
      );
    }
    for (const check of risk.checks) {
      await client.query(
        `INSERT INTO risk_checks(proposal_id,user_id,policy_id,check_code,passed,severity,observed,limit_value,evaluated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::timestamptz)`,
        [
          proposal.proposalId,
          command.userId,
          inputs.policy.policyId,
          check.code,
          check.passed,
          check.severity,
          jsonScalar(check.observed),
          jsonScalar(check.limit),
          risk.evaluatedAt
        ]
      );
    }
    for (const event of aggregate.transitions) {
      await client.query(
        `INSERT INTO trade_proposal_events(proposal_id,user_id,from_status,to_status,actor_type,actor_id,reason_code,
           correlation_id,idempotency_key,metadata,occurred_at)
         VALUES($1,$2,$3::proposal_status,$4::proposal_status,$5,$6,$7,$8,$9,$10::jsonb,$11::timestamptz)`,
        [
          proposal.proposalId,
          command.userId,
          event.fromStatus,
          event.toStatus,
          event.actorType,
          event.actorId,
          event.reasonCode,
          event.correlationId,
          event.idempotencyKey,
          JSON.stringify(event.metadata),
          event.occurredAt
        ]
      );
    }
    if (!risk.passed || binding.approval_mode === "observe") return;

    await client.query(
      `INSERT INTO capital_reservations(id,user_id,broker_account_id,user_agent_id,proposal_id,symbol,side,amount,idempotency_key,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,'buy',$7,$8,$9::timestamptz)`,
      [
        stableUuid(`reservation:${proposal.proposalId}`),
        command.userId,
        binding.broker_account_id,
        command.userAgentId,
        proposal.proposalId,
        proposal.symbol,
        proposal.notionalEstimate,
        `reservation:${proposal.proposalId}`,
        proposal.expirationTimestamp
      ]
    );
    if (binding.approval_mode === "confirm_every_trade") {
      await client.query(
        `INSERT INTO approval_requests(id,proposal_id,user_id,status,idempotency_key,requested_at,expires_at)
         VALUES($1,$2,$3,'pending',$4,$5::timestamptz,$6::timestamptz)`,
        [
          stableUuid(`approval:${proposal.proposalId}`),
          proposal.proposalId,
          command.userId,
          `approval:${proposal.proposalId}`,
          now,
          proposal.expirationTimestamp
        ]
      );
      const notificationKey = `proposal-ready:${proposal.proposalId}`;
      const payload = {
        notificationType: "proposal_ready",
        priority: "time_sensitive",
        title: "Trade proposal ready",
        privateBody: `Review ${proposal.quantity} shares of ${proposal.symbol} at a $${proposal.limitPrice?.toFixed(2)} limit.`,
        publicBody: "Open Yield to review a trade proposal.",
        deepLink: "yield://proposals",
        occurredAt: now,
        notificationIdempotencyKey: notificationKey
      };
      await insertQueueJob(client, "notifications", command.userId, "deliver_notification", payload, notificationKey);
      return;
    }
    const executionKey = `submit:${proposal.proposalId}`;
    await insertQueueJob(
      client,
      "execution",
      command.userId,
      "submit_approved",
      { proposalId: proposal.proposalId, idempotencyKey: executionKey, correlationId: command.correlationId },
      executionKey
    );
  }

  async #completeNoAction(
    client: PoolClient,
    command: PersistentAgentRunCommand,
    binding: AgentBindingRow,
    runId: string,
    now: string,
    symbol: string,
    rejectionCode: string
  ): Promise<PersistentAgentRunResult> {
    await client.query(
      `INSERT INTO agent_run_candidates(id,agent_run_id,user_id,symbol,decision,rejection_codes,structured_rationale)
       VALUES($1,$2,$3,$4,'rejected',$5::text[],$6::jsonb)`,
      [
        stableUuid(`candidate:${runId}`),
        runId,
        command.userId,
        symbol,
        [rejectionCode],
        JSON.stringify({ deterministic: true, strategyVersion: binding.deterministic_strategy_version })
      ]
    );
    await client.query(
      `UPDATE agent_runs SET status='completed',completed_at=$3::timestamptz,error_code=NULL,
         structured_outcome=$4::jsonb WHERE id=$1 AND user_id=$2`,
      [runId, command.userId, now, JSON.stringify({ outcome: "no_action", rejectionCodes: [rejectionCode] })]
    );
    return Object.freeze({ runId, userAgentId: command.userAgentId, status: "completed" });
  }

  async #existingRun(client: PoolClient, idempotencyKey: string): Promise<ExistingRunRow | undefined> {
    const result = await client.query<ExistingRunRow>(
      `SELECT id,user_id::text,user_agent_id::text,status,error_code FROM agent_runs
       WHERE idempotency_key=$1 FOR UPDATE`,
      [idempotencyKey]
    );
    return result.rows[0];
  }

  async #replayResult(
    client: PoolClient,
    row: ExistingRunRow,
    command: PersistentAgentRunCommand
  ): Promise<PersistentAgentRunResult> {
    if (row.user_id !== command.userId || row.user_agent_id !== command.userAgentId) {
      throw new DomainError("AGENT_RUN_IDEMPOTENCY_CONFLICT", "Agent run idempotency ownership conflicts", 409);
    }
    if (!new Set(["completed", "failed"]).has(row.status)) {
      throw new DomainError("AGENT_RUN_IN_PROGRESS", "The idempotent agent run is still in progress", 409);
    }
    const proposal = await client.query<{ id: string; status: ProposalStatus }>(
      `SELECT id,status FROM trade_proposals WHERE agent_run_id=$1 AND user_id=$2 ORDER BY created_at LIMIT 1`,
      [row.id, command.userId]
    );
    const proposalRow = proposal.rows[0];
    return Object.freeze({
      runId: row.id,
      userAgentId: command.userAgentId,
      status: row.status as "completed" | "failed",
      ...(proposalRow === undefined ? {} : { proposalId: proposalRow.id, proposalStatus: proposalRow.status }),
      ...(row.error_code === null ? {} : { errorCode: row.error_code })
    });
  }

  async #loadBinding(client: PoolClient, userId: string, userAgentId: string, now: string): Promise<AgentBindingRow> {
    const result = await client.query<AgentBindingRow>(
      `SELECT app_user.id::text AS user_id,app_user.status AS user_status,app_user.account_mode,
         user_agent.id::text AS user_agent_id,user_agent.status AS user_agent_status,
         user_agent.environment AS user_agent_environment,user_agent.allocation_limit::text,user_agent.approval_mode,
         configuration.id::text AS configuration_id,configuration.configuration,
         version.id::text AS agent_version_id,version.version AS agent_version,version.status AS agent_version_status,
         version.required_plan_key,version.deterministic_strategy_version,version.definition AS persisted_definition,
         definition.id::text AS agent_definition_id,definition.agent_key,
         account.id::text AS broker_account_id,account.verified_for_trading_at,account.active AS account_active,
         account.is_agentic_account,connection.id::text AS connection_id,connection.status AS connection_status,
         connection.last_sync_at AS connection_last_sync_at,connection.revoked_at AS connection_revoked_at
       FROM user_agents AS user_agent
       JOIN users AS app_user ON app_user.id=user_agent.user_id
       JOIN agent_versions AS version ON version.id=user_agent.agent_version_id
       JOIN agent_definitions AS definition ON definition.id=version.agent_definition_id
       LEFT JOIN LATERAL (
         SELECT current_config.id,current_config.configuration FROM agent_configurations AS current_config
         WHERE current_config.user_agent_id=user_agent.id AND current_config.user_id=user_agent.user_id
           AND current_config.effective_at<=$3::timestamptz
           AND (current_config.superseded_at IS NULL OR current_config.superseded_at>$3::timestamptz)
         ORDER BY current_config.version DESC LIMIT 1
       ) AS configuration ON true
       JOIN broker_connections AS connection ON connection.user_id=user_agent.user_id AND connection.status='connected'
       JOIN broker_accounts AS account ON account.connection_id=connection.id AND account.user_id=user_agent.user_id
         AND account.is_agentic_account AND account.active
       WHERE user_agent.id=$2 AND user_agent.user_id=$1 AND user_agent.deleted_at IS NULL`,
      [userId, userAgentId, now]
    );
    const row = result.rows[0];
    if (row === undefined || result.rows.length !== 1) {
      throw new DomainError("AGENT_BINDING_NOT_FOUND", "A unique current agent and Agentic Account binding is required", 404);
    }
    return row;
  }

  async #validatePlanCycleResearch(
    client: PoolClient,
    userId: string,
    context: ScheduledPlanCycleContext,
    binding: AgentBindingRow,
    now: string
  ): Promise<PlanCycleResearchRow> {
    if (
      binding.agent_version_id !== context.agentVersionId ||
      binding.deterministic_strategy_version !== context.deterministicStrategyVersion
    ) {
      throw new DomainError(
        "PLAN_CYCLE_BINDING_INVALID",
        "The scheduled plan cycle does not match the tenant's current agent version",
        409
      );
    }
    const result = await client.query<PlanCycleResearchRow>(
      `SELECT cycle.id AS plan_cycle_id,cycle.evaluation_as_of,cycle.strategy_version,
         artifact.id::text AS artifact_id,artifact.decision_sha256,artifact.context_sha256,
         artifact.request_sha256,
         artifact.provider_id,artifact.model_id,artifact.source_as_of,artifact.created_at,
         artifact.sanitized_decision
       FROM paper_plan_cycles AS cycle
       JOIN paper_plan_research_artifacts AS artifact ON artifact.plan_cycle_id=cycle.id
       JOIN plan_agent_catalog_versions AS catalog
         ON catalog.id=cycle.catalog_version_id AND catalog.plan_id=cycle.plan_id
       JOIN plan_agent_catalog_entries AS assignment
         ON assignment.catalog_version_id=catalog.id AND assignment.agent_version_id=cycle.agent_version_id
       WHERE cycle.id=$1 AND cycle.plan_id=$2 AND cycle.catalog_version_id=$3
         AND cycle.agent_version_id=$4 AND cycle.strategy_version=$5
         AND cycle.evaluation_as_of=$6::timestamptz
         AND artifact.id=$7 AND artifact.decision_sha256=$8
         AND catalog.activated_at IS NOT NULL AND catalog.activated_at<=cycle.evaluation_as_of
         AND catalog.superseded_at IS NULL
         AND artifact.provider_id='hermes' AND artifact.model_id='treasury-bot'
         AND artifact.source_as_of=cycle.evaluation_as_of
         AND artifact.source_as_of<=$10::timestamptz+interval '5 seconds'
         AND artifact.source_as_of>$10::timestamptz-($11::text||' seconds')::interval
         AND cycle.evaluation_as_of<=$10::timestamptz+interval '5 seconds'
         AND cycle.evaluation_as_of>$10::timestamptz-($11::text||' seconds')::interval
         AND EXISTS (
           SELECT 1 FROM subscriptions AS subscription
           WHERE subscription.user_id=$9 AND subscription.plan_id=cycle.plan_id
             AND subscription.status IN ('active','grace_period')
             AND subscription.effective_at<=cycle.evaluation_as_of
             AND subscription.revoked_at IS NULL
             AND (subscription.expires_at IS NULL OR subscription.expires_at>cycle.evaluation_as_of)
             AND subscription.effective_at<=$10::timestamptz
             AND (subscription.expires_at IS NULL OR subscription.expires_at>$10::timestamptz)
         )`,
      [
        context.planCycleId,
        context.planId,
        context.planCatalogVersionId,
        context.agentVersionId,
        context.deterministicStrategyVersion,
        context.asOf,
        context.researchArtifactId,
        context.researchArtifactDigest,
        userId,
        now,
        PLAN_RESEARCH_MAX_AGE_SECONDS
      ]
    );
    const row = result.rows[0];
    if (row === undefined || result.rows.length !== 1) {
      throw new DomainError(
        "PLAN_RESEARCH_ARTIFACT_REQUIRED",
        "A unique immutable plan-cycle research artifact and current plan assignment are required",
        503
      );
    }
    if (
      !/^[0-9a-f]{64}$/.test(row.context_sha256) ||
      !/^[0-9a-f]{64}$/.test(row.request_sha256) ||
      row.provider_id !== "hermes" ||
      row.model_id !== "treasury-bot" ||
      !Number.isFinite(row.source_as_of.getTime()) ||
      !Number.isFinite(row.created_at.getTime()) ||
      typeof row.sanitized_decision !== "object" ||
      row.sanitized_decision === null ||
      Array.isArray(row.sanitized_decision)
    ) {
      throw new DomainError("PLAN_RESEARCH_ARTIFACT_INVALID", "Persisted plan research is invalid", 500);
    }
    return row;
  }

  async #loadCapabilities(client: PoolClient, connectionId: string, now: string): Promise<ReadonlySet<string>> {
    const result = await client.query<{ tool_name: string }>(
      `SELECT DISTINCT ON (tool_name) tool_name FROM broker_capabilities
       WHERE connection_id=$1 AND unavailable_at IS NULL AND last_seen_at<=$2::timestamptz+interval '5 seconds'
         AND last_seen_at>$2::timestamptz-($3::text||' seconds')::interval
       ORDER BY tool_name,last_seen_at DESC`,
      [connectionId, now, CAPABILITY_MAX_AGE_SECONDS]
    );
    return new Set(result.rows.map((row) => row.tool_name));
  }

  async #requireCurrentEligibility(client: PoolClient, userId: string, now: string): Promise<EligibilityRow> {
    const result = await client.query<EligibilityRow>(
      `SELECT adviser_client_classification
       FROM eligibility_profiles
       WHERE user_id=$1 AND eligibility_status='eligible' AND assessed_at<=$2::timestamptz
         AND (superseded_at IS NULL OR superseded_at>$2::timestamptz)
       ORDER BY assessed_at DESC,id DESC`,
      [userId, now]
    );
    const row = result.rows[0];
    if (
      row === undefined ||
      result.rows.length !== 1 ||
      !["self_directed", "adviser_client"].includes(row.adviser_client_classification)
    ) {
      throw new DomainError(
        "CURRENT_ELIGIBILITY_REQUIRED",
        "A unique current eligible investor profile is required for every Paper evaluation",
        403
      );
    }
    return row;
  }

  async #requireCurrentRiskAssessment(client: PoolClient, userId: string, now: string): Promise<void> {
    const result = await client.query<{ id: string }>(
      `SELECT id::text
       FROM risk_assessments
       WHERE user_id=$1 AND completed_at<=$2::timestamptz
         AND (superseded_at IS NULL OR superseded_at>$2::timestamptz)
       ORDER BY completed_at DESC,id DESC`,
      [userId, now]
    );
    if (result.rows.length !== 1) {
      throw new DomainError(
        "CURRENT_RISK_ASSESSMENT_REQUIRED",
        "A unique current investor risk assessment is required for every Paper evaluation",
        403
      );
    }
  }

  async #loadEntitlements(client: PoolClient, userId: string, now: string): Promise<Entitlements> {
    const result = await client.query<{ features: unknown; entitlement_values: unknown }>(
      `SELECT current_plan.features,overrides.entitlement_values
       FROM LATERAL (
         SELECT plan.features FROM subscriptions AS subscription JOIN plans AS plan ON plan.id=subscription.plan_id
         WHERE subscription.user_id=$1 AND subscription.status IN ('active','grace_period') AND plan.active
           AND subscription.effective_at<=$2::timestamptz AND subscription.revoked_at IS NULL
           AND (subscription.expires_at IS NULL OR subscription.expires_at>$2::timestamptz)
         ORDER BY subscription.effective_at DESC LIMIT 1
       ) AS current_plan
       LEFT JOIN LATERAL (
         SELECT jsonb_object_agg(latest.feature_key,latest.value) AS entitlement_values FROM (
           SELECT DISTINCT ON (feature_key) feature_key,value FROM entitlements
           WHERE user_id=$1 AND effective_at<=$2::timestamptz AND (expires_at IS NULL OR expires_at>$2::timestamptz)
           ORDER BY feature_key,effective_at DESC
         ) AS latest
       ) AS overrides ON true`,
      [userId, now]
    );
    const row = result.rows[0];
    if (row === undefined) throw new DomainError("ACTIVE_SUBSCRIPTION_REQUIRED", "A current active subscription is required", 403);
    return parseEntitlements(row.features, row.entitlement_values);
  }

  async #loadPolicy(client: PoolClient, userId: string, now: string): Promise<RiskPolicy> {
    const result = await client.query<PolicyRow>(
      `SELECT id::text,user_id::text,version,limits,exclusions,effective_at FROM risk_policies
       WHERE user_id=$1 AND effective_at<=$2::timestamptz
         AND (superseded_at IS NULL OR superseded_at>$2::timestamptz)
       ORDER BY version DESC LIMIT 1`,
      [userId, now]
    );
    const row = result.rows[0];
    if (row === undefined) throw new DomainError("CURRENT_RISK_POLICY_REQUIRED", "A current persisted risk policy is required", 409);
    return parsePolicy(row);
  }

  async #loadPortfolio(
    client: PoolClient,
    userId: string,
    accountId: string,
    connectionId: string,
    policy: RiskPolicy,
    now: string
  ): Promise<PortfolioRow> {
    const result = await client.query<PortfolioRow>(
      `SELECT snapshot.id::text,snapshot.total_value::text,snapshot.buying_power::text,
         snapshot.source_timestamp,snapshot.valid_until,sync.completed_at AS sync_completed_at,sync.snapshot_fingerprint
       FROM portfolio_snapshots AS snapshot
       JOIN broker_sync_runs AS sync ON sync.portfolio_snapshot_id=snapshot.id AND sync.user_id=snapshot.user_id
         AND sync.connection_id=$3 AND sync.source_timestamp=snapshot.source_timestamp
       WHERE snapshot.user_id=$1 AND snapshot.broker_account_id=$2 AND snapshot.environment=$4::app_environment
         AND snapshot.data_classification='paper'
         AND snapshot.source_timestamp<=$5::timestamptz+interval '5 seconds'
       ORDER BY snapshot.source_timestamp DESC,snapshot.captured_at DESC LIMIT 1`,
      [userId, accountId, connectionId, this.#mode, now]
    );
    const row = result.rows[0];
    const nowInstant = Date.parse(now);
    const age = row === undefined ? Number.POSITIVE_INFINITY : (nowInstant - row.source_timestamp.getTime()) / 1_000;
    if (
      row === undefined ||
      age > policy.maximumAccountSnapshotAgeSeconds ||
      !Number.isFinite(row.valid_until.getTime()) ||
      row.valid_until.getTime() <= nowInstant ||
      !Number.isFinite(row.sync_completed_at.getTime()) ||
      row.sync_completed_at.getTime() > nowInstant + CLOCK_SKEW_MILLISECONDS ||
      row.source_timestamp.getTime() > row.sync_completed_at.getTime() + CLOCK_SKEW_MILLISECONDS ||
      !/^[0-9a-f]{64}$/.test(row.snapshot_fingerprint)
    ) {
      throw new DomainError("AUTHORITATIVE_ACCOUNT_SNAPSHOT_REQUIRED", "A fresh persisted Agentic Account snapshot is required", 503);
    }
    numeric(row.total_value, "portfolio total value");
    numeric(row.buying_power, "portfolio buying power");
    return row;
  }

  async #loadPositions(client: PoolClient, userId: string, portfolioId: string): Promise<readonly PositionRow[]> {
    const result = await client.query<PositionRow>(
      `SELECT symbol,instrument_type,quantity::text,market_value::text,details FROM position_snapshots
       WHERE user_id=$1 AND portfolio_snapshot_id=$2`,
      [userId, portfolioId]
    );
    for (const row of result.rows) {
      const quantity = numeric(row.quantity, "position quantity");
      const marketValue = numeric(row.market_value, "position market value");
      if (!isRecord(row.details)) {
        throw new DomainError("AUTHORITATIVE_ACCOUNT_SNAPSHOT_REQUIRED", "Persisted position details must be an object", 503);
      }
      if (row.instrument_type === "equity") {
        if (!SYMBOL_PATTERN.test(row.symbol) || row.symbol !== row.symbol.toUpperCase()) {
          throw new DomainError("AUTHORITATIVE_ACCOUNT_SNAPSHOT_REQUIRED", "A persisted equity position symbol is invalid", 503);
        }
        if (quantity !== 0 || marketValue !== 0) authoritativeSector(row.details.sector, "position sector");
      }
    }
    return Object.freeze(result.rows);
  }

  async #loadQuote(client: PoolClient, symbol: string, policy: RiskPolicy, now: string): Promise<ParsedQuote> {
    const result = await client.query<QuoteRow>(
      `SELECT id::text,provider,payload,source_timestamp,received_at FROM market_data_snapshots
       WHERE symbol=$1 AND data_type='quote' AND provider=ANY($2::text[])
         AND source_timestamp<=$3::timestamptz+interval '5 seconds'
       ORDER BY source_timestamp DESC,received_at DESC LIMIT 1`,
      [symbol, this.#providers, now]
    );
    const row = result.rows[0];
    const age = row === undefined ? Number.POSITIVE_INFINITY : (Date.parse(now) - row.source_timestamp.getTime()) / 1_000;
    if (row === undefined || age > policy.maximumQuoteAgeSeconds) {
      throw new DomainError(
        "AUTHORITATIVE_MARKET_CONTEXT_REQUIRED",
        "A fresh quote and market context from an approved persisted provider is required",
        503
      );
    }
    return parseQuote(row, symbol);
  }

  async #legalConsentsCurrent(
    client: PoolClient,
    userId: string,
    now: string,
    optionsTrading: boolean,
    adviserClassification: EligibilityRow["adviser_client_classification"]
  ): Promise<boolean> {
    const requiredDocuments = [
      ...REQUIRED_LEGAL_DOCUMENTS,
      ...(optionsTrading ? ["options"] : []),
      ...(adviserClassification === "adviser_client" ? ["advisory"] : [])
    ];
    const result = await client.query<{ document_count: string; consent_count: string }>(
      `WITH current_documents AS (
         SELECT DISTINCT ON (document_key) id,document_key FROM legal_documents
         WHERE document_key=ANY($2::text[]) AND production_approved AND published_at<=$3::timestamptz
           AND (retired_at IS NULL OR retired_at>$3::timestamptz)
         ORDER BY document_key,published_at DESC,created_at DESC
       )
       SELECT count(*)::text AS document_count,
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM legal_consents AS consent WHERE consent.user_id=$1
             AND consent.legal_document_id=current_documents.id AND consent.accepted_at<=$3::timestamptz
             AND consent.revoked_at IS NULL
         ))::text AS consent_count
       FROM current_documents`,
      [userId, requiredDocuments, now]
    );
    const row = result.rows[0];
    return Number(row?.document_count ?? 0) === requiredDocuments.length &&
      Number(row?.consent_count ?? 0) === requiredDocuments.length;
  }

  async #loadMetrics(
    client: PoolClient,
    userId: string,
    userAgentId: string,
    accountId: string,
    connectionId: string,
    symbol: string,
    now: string
  ): Promise<OperationalMetricsRow> {
    const result = await client.query<OperationalMetricsRow>(
      `SELECT
         COALESCE((SELECT sum(amount) FROM capital_reservations WHERE user_id=$1 AND broker_account_id=$3
           AND user_agent_id=$2 AND released_at IS NULL AND expires_at>$5::timestamptz),0)::text AS own_reservations,
         COALESCE((SELECT sum(amount) FROM capital_reservations WHERE user_id=$1 AND broker_account_id=$3
           AND user_agent_id<>$2 AND released_at IS NULL AND expires_at>$5::timestamptz),0)::text AS other_reservations,
         COALESCE((SELECT count(DISTINCT orders.id) FROM fills JOIN orders ON orders.id=fills.order_id
           WHERE fills.user_id=$1 AND orders.broker_account_id=$3 AND fills.occurred_at>=date_trunc('day',$5::timestamptz)),0)::text AS trades_today,
         COALESCE((SELECT sum(fills.quantity*fills.price) FROM fills JOIN orders ON orders.id=fills.order_id
           WHERE fills.user_id=$1 AND orders.broker_account_id=$3 AND fills.occurred_at>=date_trunc('day',$5::timestamptz)),0)::text AS turnover_notional,
         EXISTS(SELECT 1 FROM trade_proposals WHERE user_id=$1 AND broker_account_id=$3 AND symbol=$4
           AND proposal->>'side'='buy' AND status IN ('DRAFT','ANALYZED','SCHEMA_VALIDATED','RISK_CHECKED','BROKER_REVIEWED','AWAITING_USER_APPROVAL','APPROVED')) AS duplicate_proposal,
         EXISTS(SELECT 1 FROM orders JOIN trade_proposals ON trade_proposals.id=orders.proposal_id
           WHERE orders.user_id=$1 AND orders.broker_account_id=$3 AND trade_proposals.symbol=$4
             AND trade_proposals.proposal->>'side'='buy' AND orders.status IN ('pending','submitted','partially_filled')) AS duplicate_open_order,
         (SELECT max(snapshot.total_value)::text FROM portfolio_snapshots AS snapshot
           JOIN broker_sync_runs AS sync ON sync.portfolio_snapshot_id=snapshot.id AND sync.user_id=snapshot.user_id
             AND sync.connection_id=$7 AND sync.source_timestamp=snapshot.source_timestamp
           WHERE snapshot.user_id=$1 AND snapshot.broker_account_id=$3
             AND snapshot.environment=$6::app_environment AND snapshot.data_classification='paper'
             AND snapshot.source_timestamp<=$5::timestamptz) AS peak_value,
         (SELECT snapshot.total_value::text FROM portfolio_snapshots AS snapshot
           JOIN broker_sync_runs AS sync ON sync.portfolio_snapshot_id=snapshot.id AND sync.user_id=snapshot.user_id
             AND sync.connection_id=$7 AND sync.source_timestamp=snapshot.source_timestamp
           WHERE snapshot.user_id=$1 AND snapshot.broker_account_id=$3
             AND snapshot.environment=$6::app_environment AND snapshot.data_classification='paper'
             AND snapshot.source_timestamp>=date_trunc('day',$5::timestamptz)
             AND snapshot.source_timestamp<=$5::timestamptz ORDER BY snapshot.source_timestamp LIMIT 1) AS opening_value,
         EXISTS(SELECT 1 FROM risk_events WHERE user_id=$1 AND broker_account_id=$3
           AND severity IN ('blocking','critical') AND occurred_at>$5::timestamptz-interval '24 hours') AS active_risk_halt,
         EXISTS(SELECT 1 FROM security_events WHERE user_id=$1 AND lower(severity) IN ('blocking','critical')
           AND occurred_at>$5::timestamptz-interval '24 hours' AND COALESCE(structured_details->>'active','true')<>'false') AS active_security_halt,
         EXISTS(SELECT 1 FROM system_incidents WHERE environment=$6::app_environment AND status<>'resolved'
           AND lower(severity) IN ('blocking','critical')) AS active_system_incident`,
      [userId, userAgentId, accountId, symbol, now, this.#mode, connectionId]
    );
    const row = result.rows[0];
    if (row === undefined) throw new DomainError("AUTHORITATIVE_OPERATIONAL_CONTEXT_REQUIRED", "Operational risk context is unavailable", 503);
    return row;
  }

  async #transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const value = await operation(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function assertCommand(command: PersistentAgentRunCommand): void {
  if (
    !UUID_PATTERN.test(command.userId) ||
    !UUID_PATTERN.test(command.userAgentId) ||
    command.runIdempotencyKey.length < 8 ||
    command.runIdempotencyKey.length > 200 ||
    command.correlationId.trim() === "" ||
    command.correlationId.length > 200
  ) {
    throw new DomainError("AGENT_JOB_PAYLOAD_INVALID", "The tenant-bound agent run command is invalid", 422);
  }
  if (command.planCycle !== undefined) {
    parseAgentRunJobPayload({
      userAgentId: command.userAgentId,
      runIdempotencyKey: command.runIdempotencyKey,
      planCycle: command.planCycle
    });
  }
}

function advance(
  aggregate: ProposalAggregate,
  toStatus: ProposalStatus,
  reasonCode: string,
  correlationId: string,
  occurredAt: string,
  sequence: number,
  metadata?: Readonly<Record<string, string | number | boolean | null>>
): ProposalAggregate {
  return transitionProposal(aggregate, {
    toStatus,
    actorType: "worker",
    actorId: "agent-orchestrator",
    reasonCode,
    correlationId,
    idempotencyKey: `${aggregate.proposal.proposalId}:state:${sequence}`,
    occurredAt,
    ...(metadata === undefined ? {} : { metadata })
  });
}

function parseConfiguration(value: unknown): StrategyConfiguration {
  const configuration = record(value);
  const symbol = typeof configuration.symbol === "string" ? configuration.symbol.trim().toUpperCase() : "";
  const amount = configuration.targetOrderAmount;
  if (!SYMBOL_PATTERN.test(symbol) || typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    throw new DomainError(
      "AGENT_CONFIGURATION_INVALID",
      "Foundation Equity v1 requires a valid symbol and finite positive targetOrderAmount",
      422
    );
  }
  return Object.freeze({ symbol, targetOrderAmount: amount });
}

function parsePolicy(row: PolicyRow): RiskPolicy {
  const values = { ...record(row.limits), ...record(row.exclusions) };
  const value = (name: string): number => jsonNumber(values[name], `risk policy ${name}`);
  const bool = (name: string): boolean => {
    if (typeof values[name] !== "boolean") throw new DomainError("PERSISTED_RISK_POLICY_INVALID", `Risk policy ${name} is invalid`, 500);
    return values[name];
  };
  const list = (name: string): readonly string[] => {
    const item = values[name];
    if (!Array.isArray(item) || !item.every((entry) => typeof entry === "string")) {
      throw new DomainError("PERSISTED_RISK_POLICY_INVALID", `Risk policy ${name} is invalid`, 500);
    }
    return Object.freeze(item.map((entry) => entry.toUpperCase()));
  };
  const policy = Object.freeze({
    policyId: row.id,
    userId: row.user_id,
    maximumAccountAllocation: value("maximumAccountAllocation"),
    maximumPositionAmount: value("maximumPositionAmount"),
    maximumNewOrderAmount: value("maximumNewOrderAmount"),
    maximumDailyLoss: value("maximumDailyLoss"),
    maximumPortfolioDrawdown: value("maximumPortfolioDrawdown"),
    minimumBuyingPowerReserve: value("minimumBuyingPowerReserve"),
    maximumSimultaneousPositions: value("maximumSimultaneousPositions"),
    maximumSymbolConcentration: value("maximumSymbolConcentration"),
    maximumSectorConcentration: value("maximumSectorConcentration"),
    maximumTradesPerDay: value("maximumTradesPerDay"),
    maximumDailyTurnover: value("maximumDailyTurnover"),
    maximumOptionsExposure: value("maximumOptionsExposure"),
    maximumOptionRiskPerTrade: value("maximumOptionRiskPerTrade"),
    maximumContractsPerTrade: value("maximumContractsPerTrade"),
    minimumDaysToExpiration: value("minimumDaysToExpiration"),
    maximumDaysToExpiration: value("maximumDaysToExpiration"),
    maximumBidAskSpreadRatio: value("maximumBidAskSpreadRatio"),
    maximumQuoteAgeSeconds: value("maximumQuoteAgeSeconds"),
    maximumAccountSnapshotAgeSeconds: value("maximumAccountSnapshotAgeSeconds"),
    maximumPriceDeviationRatio: value("maximumPriceDeviationRatio"),
    excludedSymbols: list("excludedSymbols"),
    excludedSectors: list("excludedSectors"),
    fractionalSharesPermitted: bool("fractionalSharesPermitted"),
    extendedHoursPermitted: bool("extendedHoursPermitted"),
    earningsTradesPermitted: bool("earningsTradesPermitted"),
    coveredCallsPermitted: bool("coveredCallsPermitted"),
    protectivePutsPermitted: bool("protectivePutsPermitted"),
    definedRiskSpreadsPermitted: bool("definedRiskSpreadsPermitted"),
    updatedAt: row.effective_at.toISOString(),
    version: row.version
  });
  const violations = validateUserPolicyAgainstPlatform(policy);
  if (violations.length > 0) {
    throw new DomainError(
      "PERSISTED_RISK_POLICY_INVALID",
      "Persisted risk policy exceeds platform bounds or has invalid value semantics",
      500,
      { fields: violations }
    );
  }
  return policy;
}

function parseEntitlements(planValue: unknown, overrideValue: unknown): Entitlements {
  const values = { ...record(planValue), ...record(overrideValue) };
  const boolean = (name: string): boolean => values[name] === true;
  const integer = (name: string): number => {
    const value = values[name];
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
  };
  const catalog = values.agentCatalog;
  return Object.freeze({
    stockTrading: boolean("stockTrading"),
    optionsTrading: boolean("optionsTrading"),
    multiLegOptions: boolean("multiLegOptions"),
    maximumActiveAgents: integer("maximumActiveAgents"),
    automaticMode: boolean("automaticMode"),
    monitoringFrequencyMinutes: integer("monitoringFrequencyMinutes"),
    advancedAnalytics: boolean("advancedAnalytics"),
    customWatchlists: boolean("customWatchlists"),
    scannerAccess: boolean("scannerAccess"),
    agentCatalog: Object.freeze(Array.isArray(catalog) && catalog.every((entry) => typeof entry === "string") ? [...catalog] : []),
    prioritySupport: boolean("prioritySupport")
  });
}

function parseQuote(row: QuoteRow, symbol: string): ParsedQuote {
  const payload = record(row.payload);
  const bid = jsonNumber(payload.bid, "quote bid");
  const ask = jsonNumber(payload.ask, "quote ask");
  const last = jsonNumber(payload.last, "quote last");
  const marketSession = payload.marketSession;
  const warning = payload.brokerWarningSeverity;
  const sector = authoritativeSector(payload.sector, "quote sector", "AUTHORITATIVE_MARKET_CONTEXT_REQUIRED");
  const booleanValue = (name: string): boolean => {
    const value = payload[name];
    if (typeof value !== "boolean") {
      throw new DomainError("AUTHORITATIVE_MARKET_CONTEXT_REQUIRED", `Approved quote ${name} is missing`, 503);
    }
    return value;
  };
  if (
    payload.symbol !== symbol ||
    bid < 0 ||
    ask <= 0 ||
    ask < bid ||
    last <= 0 ||
    !["open", "extended", "closed"].includes(String(marketSession)) ||
    !["none", "informational", "blocking"].includes(String(warning))
  ) {
    throw new DomainError("AUTHORITATIVE_MARKET_CONTEXT_REQUIRED", "Approved persisted quote context is invalid", 503);
  }
  return Object.freeze({
    id: row.id,
    provider: row.provider,
    sourceTimestamp: row.source_timestamp.toISOString(),
    bid,
    ask,
    last,
    tradable: booleanValue("tradable"),
    fractionalSupported: booleanValue("fractionalSupported"),
    liquiditySufficient: booleanValue("liquiditySufficient"),
    marketSession: marketSession as ParsedQuote["marketSession"],
    volatilityHalt: booleanValue("volatilityHalt"),
    tradingHalt: booleanValue("tradingHalt"),
    corporateActionRestricted: booleanValue("corporateActionRestricted"),
    earningsWindow: booleanValue("earningsWindow"),
    sector,
    brokerWarningSeverity: warning as ParsedQuote["brokerWarningSeverity"],
    rawPayload: payload
  });
}

async function insertQueueJob(
  client: PoolClient,
  queueName: string,
  userId: string,
  jobType: string,
  payload: Readonly<Record<string, unknown>>,
  idempotencyKey: string
): Promise<void> {
  const result = await client.query(
    `INSERT INTO queue_jobs(queue_name,user_id,job_type,payload,idempotency_key)
     VALUES($1,$2,$3,$4::jsonb,$5)
     ON CONFLICT(queue_name,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
     WHERE queue_jobs.user_id=EXCLUDED.user_id AND queue_jobs.job_type=EXCLUDED.job_type AND queue_jobs.payload=EXCLUDED.payload`,
    [queueName, userId, jobType, JSON.stringify(payload), idempotencyKey]
  );
  // This occurs only after proposal persistence has begun. Keep it outside the
  // handled domain-validation class so the enclosing transaction rolls back
  // the entire proposal/approval/reservation graph instead of committing a
  // partially enqueued workflow.
  if (result.rowCount !== 1) throw new Error("Queue idempotency key conflicts with another payload");
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return isRecord(value)
    ? value as Readonly<Record<string, unknown>>
    : Object.freeze({});
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function authoritativeSector(
  value: unknown,
  name: string,
  code = "AUTHORITATIVE_ACCOUNT_SNAPSHOT_REQUIRED"
): string {
  const sector = typeof value === "string" ? value.trim() : "";
  if (sector === "" || sector.length > SECTOR_MAX_LENGTH || /[\u0000-\u001F\u007F]/u.test(sector)) {
    throw new DomainError(code, `${name} is missing or invalid`, 503);
  }
  return sector;
}

function finite(value: unknown, name: string): number {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(number)) throw new DomainError("AUTHORITATIVE_NUMERIC_VALUE_INVALID", `${name} is not finite`, 500);
  return number;
}

function jsonNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new DomainError("AUTHORITATIVE_NUMERIC_VALUE_INVALID", `${name} is not a JSON number`, 500);
  }
  return value;
}

function numeric(value: string, name: string): number {
  return finite(value, name);
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function eventTime(startedAt: string, sequence: number): string {
  return new Date(Date.parse(startedAt) + sequence).toISOString();
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function jsonScalar(value: string | number | boolean | undefined): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function stableUuid(scope: string): string {
  const hash = createHash("sha256").update(scope).digest("hex");
  const variant = ((Number.parseInt(hash[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
