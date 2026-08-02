import { DomainError } from "@whox/contracts";

export const STEP_UP_ACTIONS = Object.freeze([
  "approve_trade_proposal",
  "resume_user_agent",
  "resume_all_user_agents",
  "disconnect_broker_connection",
  "delete_account",
  "relax_risk_policy"
] as const);

export type StepUpAction = (typeof STEP_UP_ACTIONS)[number];

export interface StepUpVerificationContext {
  readonly userId: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly action: StepUpAction;
  readonly resourceId: string;
  readonly proof: Readonly<Record<string, unknown>>;
  readonly now: Date;
}

export interface VerifiedStepUpAuthentication {
  readonly verificationId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly action: StepUpAction;
  readonly resourceId: string;
  readonly method: "app_attest" | "devicecheck" | "webauthn";
  readonly authenticatedAt: string;
  readonly expiresAt: string;
}

export interface StepUpAuthenticationVerifier {
  verify(context: StepUpVerificationContext): Promise<VerifiedStepUpAuthentication>;
}

export interface SensitiveOperationStepUpInput {
  readonly verifier: StepUpAuthenticationVerifier;
  readonly userId: string;
  readonly sessionId: string;
  readonly authenticatedDeviceId: string;
  readonly action: StepUpAction;
  readonly resourceId: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly now: Date;
  readonly consume?: (verification: VerifiedStepUpAuthentication) => void | Promise<void>;
}

export class UnavailableStepUpAuthenticationVerifier implements StepUpAuthenticationVerifier {
  public async verify(_context: StepUpVerificationContext): Promise<VerifiedStepUpAuthentication> {
    throw new DomainError("STEP_UP_VERIFICATION_UNAVAILABLE", "Server-side device-authentication verification is not configured", 503);
  }
}

const plainObject = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;

/**
 * Verifies a fresh proof against the authenticated session and the exact
 * server-selected operation resource. The optional consumer is the durable,
 * atomic replay boundary and runs only after every binding/freshness check.
 */
export async function requireSensitiveOperationStepUp(input: SensitiveOperationStepUpInput): Promise<VerifiedStepUpAuthentication> {
  if (input.resourceId.length === 0 || input.resourceId.length > 512 || /[\u0000-\u001f\u007f]/.test(input.resourceId)) {
    throw new DomainError("STEP_UP_RESOURCE_INVALID", "The step-up operation resource is invalid", 500);
  }
  const deviceContext = plainObject(input.body.deviceContext);
  const assertedDeviceId = typeof input.body.deviceId === "string"
    ? input.body.deviceId
    : typeof deviceContext?.deviceId === "string"
      ? deviceContext.deviceId
      : undefined;
  if (assertedDeviceId === undefined) throw new DomainError("STEP_UP_DEVICE_REQUIRED", "The signed-in device context is required for this operation", 403);
  if (assertedDeviceId !== input.authenticatedDeviceId) throw new DomainError("STEP_UP_DEVICE_MISMATCH", "The operation device does not match the authenticated session", 403);
  const proof = plainObject(input.body.stepUpProof ?? input.body.authenticationProof);
  if (proof === undefined || Object.keys(proof).length === 0) throw new DomainError("STEP_UP_PROOF_REQUIRED", "A server-verifiable step-up authentication proof is required", 403);
  const context: StepUpVerificationContext = Object.freeze({
    userId: input.userId,
    sessionId: input.sessionId,
    deviceId: input.authenticatedDeviceId,
    action: input.action,
    resourceId: input.resourceId,
    proof,
    now: input.now
  });
  const verification = await input.verifier.verify(context);
  validateVerifiedStepUp(context, verification);
  await input.consume?.(verification);
  return verification;
}

export function validateVerifiedStepUp(context: StepUpVerificationContext, verification: VerifiedStepUpAuthentication, maximumAgeMs = 5 * 60_000): void {
  if (typeof verification !== "object" || verification === null) throw new DomainError("STEP_UP_PROOF_INVALID", "The verified authentication result is invalid", 403);
  if (verification.userId !== context.userId || verification.sessionId !== context.sessionId || verification.deviceId !== context.deviceId || verification.action !== context.action || verification.resourceId !== context.resourceId) {
    throw new DomainError("STEP_UP_CONTEXT_MISMATCH", "The verified authentication proof is not bound to this user, session, device, action, and resource", 403);
  }
  const authenticatedAt = Date.parse(verification.authenticatedAt);
  const expiresAt = Date.parse(verification.expiresAt);
  const now = context.now.getTime();
  if (!Number.isFinite(authenticatedAt) || !Number.isFinite(expiresAt) || authenticatedAt > now + 30_000 || now - authenticatedAt > maximumAgeMs || expiresAt <= now || expiresAt <= authenticatedAt) {
    throw new DomainError("STEP_UP_PROOF_STALE", "The verified authentication proof is stale or expired", 403);
  }
  if (typeof verification.verificationId !== "string" || !/^[\x21-\x7e]{8,255}$/.test(verification.verificationId)) {
    throw new DomainError("STEP_UP_PROOF_INVALID", "The verified authentication proof identifier is invalid", 403);
  }
  if (!(STEP_UP_ACTIONS as readonly string[]).includes(verification.action)) throw new DomainError("STEP_UP_PROOF_INVALID", "The verified authentication action is not supported", 403);
  if (!["app_attest", "devicecheck", "webauthn"].includes(verification.method)) throw new DomainError("STEP_UP_PROOF_INVALID", "The verified authentication method is not supported", 403);
}
