import { DomainError } from "@whox/contracts";
import { Pool } from "pg";
import {
  parseSanitizedHermesResearchArtifact,
  type SanitizedHermesResearchArtifact
} from "./hermes-research.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;
const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,14}$/;

export interface PlanResearchQuoteContext {
  readonly symbol: string;
  readonly sector: string;
  readonly bid: number;
  readonly ask: number;
  readonly last: number;
  readonly sourceTimestamp: string;
  readonly marketSession: "open" | "extended" | "closed";
  readonly liquiditySufficient: boolean;
  readonly volatilityHalt: boolean;
  readonly tradingHalt: boolean;
}

export interface PlanResearchContext {
  readonly planCycleId: string;
  readonly planId: string;
  readonly planKey: string;
  readonly planCatalogVersionId: string;
  readonly planAgentAssignmentId: string;
  readonly agentVersionId: string;
  readonly agentKey: string;
  readonly agentVersion: string;
  readonly deterministicStrategyVersion: string;
  readonly asOf: string;
  readonly sourceAsOf: string;
  readonly contextDigest: string;
  readonly symbols: readonly PlanResearchQuoteContext[];
}

export interface PlanResearchArtifact {
  readonly id: string;
  readonly planCycleId: string;
  readonly provider: "hermes";
  readonly model: "treasury-bot";
  readonly sourceAsOf: string;
  readonly contextDigest: string;
  readonly requestDigest: string;
  readonly decisionDigest: string;
  readonly sanitizedDecision: SanitizedHermesResearchArtifact;
  readonly createdAt: string;
}

export interface SavePlanResearchArtifactCommand {
  readonly provider: "hermes";
  readonly model: "treasury-bot";
  readonly sourceAsOf: string;
  readonly contextDigest: string;
  readonly requestDigest: string;
  readonly sanitizedDecision: SanitizedHermesResearchArtifact;
}

interface ContextRow {
  plan_cycle_id: string;
  plan_id: string;
  plan_key: string;
  catalog_version_id: string;
  plan_agent_assignment_id: string;
  agent_version_id: string;
  agent_key: string;
  agent_version: string;
  strategy_version: string;
  evaluation_as_of: Date;
  source_as_of: Date;
  context_sha256: string;
  research_universe: unknown;
}

interface ArtifactRow {
  id: string;
  plan_cycle_id: string;
  provider_id: string;
  model_id: string;
  source_as_of: Date;
  context_sha256: string;
  request_sha256: string;
  decision_sha256: string;
  sanitized_decision: unknown;
  created_at: Date;
}

/**
 * Service-only persistence for one sanitized public-market research artifact
 * per plan-agent-version cycle. The SQL boundary returns no tenant, account,
 * portfolio, policy, credential, order, or broker-connection fields.
 */
export class PostgresPlanResearchRepository {
  readonly #pool: Pool;
  readonly #providerId: string;
  readonly #maximumQuoteAgeSeconds: number;

  public constructor(databaseUrl: string, providerId: string, maximumQuoteAgeSeconds = 60) {
    if (databaseUrl.trim() === "") throw new TypeError("DATABASE_URL is required");
    if (!IDENTIFIER_PATTERN.test(providerId)) throw new TypeError("An approved public market-data provider is required");
    if (!Number.isInteger(maximumQuoteAgeSeconds) || maximumQuoteAgeSeconds < 1 || maximumQuoteAgeSeconds > 300) {
      throw new TypeError("Plan research quote age must be an integer from 1 through 300 seconds");
    }
    this.#providerId = providerId;
    this.#maximumQuoteAgeSeconds = maximumQuoteAgeSeconds;
    this.#pool = new Pool({ connectionString: databaseUrl, application_name: "whox-plan-research", max: 4 });
  }

  public async claimContext(planCycleId: string): Promise<PlanResearchContext | undefined> {
    if (!validPlanCycleId(planCycleId)) throw invalidContext();
    const result = await this.#pool.query<ContextRow>(
      `SELECT plan_cycle_id,plan_id,catalog_version_id,plan_agent_assignment_id,agent_version_id,
         plan_key,agent_key,agent_version,strategy_version,evaluation_as_of,source_as_of,context_sha256,
         research_universe
       FROM app.paper_plan_research_context($1,$2,$3)`,
      [planCycleId, this.#providerId, this.#maximumQuoteAgeSeconds]
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    if (result.rows.length !== 1) throw invalidContext();
    const symbols = parseResearchUniverse(row.research_universe);
    if (
      row.plan_cycle_id !== planCycleId ||
      !UUID_PATTERN.test(row.plan_id) ||
      !UUID_PATTERN.test(row.catalog_version_id) ||
      !UUID_PATTERN.test(row.agent_version_id) ||
      !IDENTIFIER_PATTERN.test(row.plan_key) ||
      !IDENTIFIER_PATTERN.test(row.agent_key) ||
      !IDENTIFIER_PATTERN.test(row.agent_version) ||
      !IDENTIFIER_PATTERN.test(row.strategy_version) ||
      !Number.isFinite(row.evaluation_as_of.getTime()) ||
      !Number.isFinite(row.source_as_of.getTime()) ||
      !DIGEST_PATTERN.test(row.context_sha256)
    ) {
      throw invalidContext();
    }
    return Object.freeze({
      planCycleId: row.plan_cycle_id,
      planId: row.plan_id,
      planKey: row.plan_key,
      planCatalogVersionId: row.catalog_version_id,
      planAgentAssignmentId: row.plan_agent_assignment_id,
      agentVersionId: row.agent_version_id,
      agentKey: row.agent_key,
      agentVersion: row.agent_version,
      deterministicStrategyVersion: row.strategy_version,
      asOf: row.evaluation_as_of.toISOString(),
      sourceAsOf: row.source_as_of.toISOString(),
      contextDigest: row.context_sha256,
      symbols
    });
  }

  public async saveArtifact(
    planCycleId: string,
    command: SavePlanResearchArtifactCommand
  ): Promise<PlanResearchArtifact> {
    if (
      !validPlanCycleId(planCycleId) ||
      command.provider !== "hermes" ||
      command.model !== "treasury-bot" ||
      !Number.isFinite(Date.parse(command.sourceAsOf)) ||
      !DIGEST_PATTERN.test(command.contextDigest) ||
      !DIGEST_PATTERN.test(command.requestDigest)
    ) {
      throw new DomainError("PLAN_RESEARCH_ARTIFACT_INVALID", "The plan research artifact is invalid", 422);
    }
    const result = await this.#pool.query<ArtifactRow>(
      `SELECT id,plan_cycle_id,provider_id,model_id,source_as_of,context_sha256,request_sha256,
         decision_sha256,sanitized_decision,created_at
       FROM app.record_paper_plan_research_artifact($1,$2,$3,$4::timestamptz,$5,$6,$7::jsonb)`,
      [
        planCycleId,
        command.provider,
        command.model,
        command.sourceAsOf,
        command.contextDigest,
        command.requestDigest,
        JSON.stringify(parseSanitizedHermesResearchArtifact(command.sanitizedDecision))
      ]
    );
    const row = result.rows[0];
    if (row === undefined || result.rows.length !== 1) {
      throw new DomainError("PLAN_RESEARCH_ARTIFACT_CONFLICT", "The plan cycle already has different research", 409);
    }
    return parseArtifact(row);
  }

  public async loadArtifact(input: {
    readonly planCycleId: string;
    readonly artifactId: string;
    readonly digest: string;
  }): Promise<PlanResearchArtifact | undefined> {
    if (!validPlanCycleId(input.planCycleId) || !UUID_PATTERN.test(input.artifactId) || !DIGEST_PATTERN.test(input.digest)) {
      throw new DomainError("PLAN_RESEARCH_ARTIFACT_INVALID", "The plan research artifact reference is invalid", 422);
    }
    const result = await this.#pool.query<ArtifactRow>(
      `SELECT id::text,plan_cycle_id,provider_id,model_id,source_as_of,context_sha256,
         request_sha256,decision_sha256,sanitized_decision,created_at
       FROM paper_plan_research_artifacts
       WHERE id=$1 AND plan_cycle_id=$2 AND decision_sha256=$3`,
      [input.artifactId, input.planCycleId, input.digest]
    );
    return result.rows[0] === undefined ? undefined : parseArtifact(result.rows[0]);
  }

  public async findByCycle(planCycleId: string): Promise<PlanResearchArtifact | undefined> {
    if (!validPlanCycleId(planCycleId)) {
      throw new DomainError("PLAN_RESEARCH_ARTIFACT_INVALID", "The plan research cycle reference is invalid", 422);
    }
    const result = await this.#pool.query<ArtifactRow>(
      `SELECT id::text,plan_cycle_id,provider_id,model_id,source_as_of,context_sha256,
         request_sha256,decision_sha256,sanitized_decision,created_at
       FROM paper_plan_research_artifacts WHERE plan_cycle_id=$1`,
      [planCycleId]
    );
    return result.rows[0] === undefined ? undefined : parseArtifact(result.rows[0]);
  }

  public async close(): Promise<void> {
    await this.#pool.end();
  }
}

function parseResearchUniverse(value: unknown): readonly PlanResearchQuoteContext[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) throw invalidContext();
  const parsed = value.map((item) => {
    if (!isRecord(item)) throw invalidContext();
    assertExactKeys(item, [
      "symbol",
      "sector",
      "bid",
      "ask",
      "last",
      "sourceTimestamp",
      "marketSession",
      "liquiditySufficient",
      "volatilityHalt",
      "tradingHalt"
    ]);
    const sourceTimestamp = item.sourceTimestamp;
    const marketSession = item.marketSession;
    if (
      typeof item.symbol !== "string" ||
      !SYMBOL_PATTERN.test(item.symbol) ||
      typeof item.sector !== "string" ||
      item.sector.length < 1 ||
      item.sector.length > 100 ||
      typeof item.bid !== "number" ||
      typeof item.ask !== "number" ||
      typeof item.last !== "number" ||
      !Number.isFinite(item.bid) ||
      !Number.isFinite(item.ask) ||
      !Number.isFinite(item.last) ||
      item.bid < 0 ||
      item.ask <= 0 ||
      item.last <= 0 ||
      item.ask < item.bid ||
      typeof sourceTimestamp !== "string" ||
      !Number.isFinite(Date.parse(sourceTimestamp)) ||
      (marketSession !== "open" && marketSession !== "extended" && marketSession !== "closed") ||
      typeof item.liquiditySufficient !== "boolean" ||
      typeof item.volatilityHalt !== "boolean" ||
      typeof item.tradingHalt !== "boolean"
    ) {
      throw invalidContext();
    }
    return Object.freeze({
      symbol: item.symbol,
      sector: item.sector,
      bid: item.bid,
      ask: item.ask,
      last: item.last,
      sourceTimestamp: new Date(sourceTimestamp).toISOString(),
      marketSession,
      liquiditySufficient: item.liquiditySufficient,
      volatilityHalt: item.volatilityHalt,
      tradingHalt: item.tradingHalt
    });
  });
  const symbols = parsed.map((item) => item.symbol);
  const sorted = [...symbols].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (new Set(symbols).size !== symbols.length || symbols.some((symbol, index) => symbol !== sorted[index])) {
    throw invalidContext();
  }
  return Object.freeze(parsed);
}

function assertExactKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) throw invalidContext();
}

function parseArtifact(row: ArtifactRow): PlanResearchArtifact {
  if (
    !UUID_PATTERN.test(row.id) ||
    !validPlanCycleId(row.plan_cycle_id) ||
    row.provider_id !== "hermes" ||
    row.model_id !== "treasury-bot" ||
    !Number.isFinite(row.source_as_of.getTime()) ||
    !Number.isFinite(row.created_at.getTime()) ||
    !DIGEST_PATTERN.test(row.context_sha256) ||
    !DIGEST_PATTERN.test(row.request_sha256) ||
    !DIGEST_PATTERN.test(row.decision_sha256)
  ) {
    throw new DomainError("PLAN_RESEARCH_ARTIFACT_INVALID", "Persisted plan research is invalid", 500);
  }
  return Object.freeze({
    id: row.id,
    planCycleId: row.plan_cycle_id,
    provider: "hermes",
    model: "treasury-bot",
    sourceAsOf: row.source_as_of.toISOString(),
    contextDigest: row.context_sha256,
    requestDigest: row.request_sha256,
    decisionDigest: row.decision_sha256,
    sanitizedDecision: parseSanitizedHermesResearchArtifact(row.sanitized_decision),
    createdAt: row.created_at.toISOString()
  });
}

function validPlanCycleId(value: string): boolean {
  const parts = value.split(":");
  return parts.length === 6 && parts[0] === "paper-plan-cycle" &&
    UUID_PATTERN.test(parts[1] ?? "") && UUID_PATTERN.test(parts[2] ?? "") &&
    UUID_PATTERN.test(parts[3] ?? "") && /^\d{1,12}$/.test(parts[4] ?? "") &&
    /^\d{1,12}$/.test(parts[5] ?? "") && Number(parts[5]) >= Number(parts[4]);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidContext(): DomainError {
  return new DomainError(
    "PLAN_RESEARCH_CONTEXT_UNAVAILABLE",
    "A complete bounded public-market plan research context is not available",
    503
  );
}
