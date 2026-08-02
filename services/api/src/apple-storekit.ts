import { createHash, X509Certificate } from "node:crypto";
import {
  Environment,
  InAppOwnershipType,
  SignedDataVerifier,
  Type,
  VerificationException,
  VerificationStatus,
  type JWSRenewalInfoDecodedPayload,
  type JWSTransactionDecodedPayload,
  type ResponseBodyV2DecodedPayload
} from "@apple/app-store-server-library";
import { DomainError } from "@whox/contracts";
import type {
  StoreKitSyncRequest,
  StoreKitTransactionVerifier,
  VerifiedStoreKitTransaction
} from "./storekit.js";

export type AppStoreEnvironment = "Sandbox" | "Production";

export interface AppleSignedDataVerifier {
  verifyAndDecodeTransaction(signedTransactionInfo: string): Promise<JWSTransactionDecodedPayload>;
  verifyAndDecodeRenewalInfo(signedRenewalInfo: string): Promise<JWSRenewalInfoDecodedPayload>;
  verifyAndDecodeNotification(signedPayload: string): Promise<ResponseBodyV2DecodedPayload>;
}

export interface AppleStoreKitVerifierConfiguration {
  readonly rootCertificates: readonly Buffer[];
  readonly bundleId: string;
  readonly appAppleId?: number;
  readonly environments: readonly AppStoreEnvironment[];
}

export interface VerifiedAppStoreRenewal {
  readonly originalTransactionID: string;
  readonly productID?: string;
  readonly autoRenewProductID?: string;
  readonly environment: AppStoreEnvironment;
  readonly appAccountToken?: string;
  readonly isInBillingRetryPeriod?: boolean;
  readonly gracePeriodExpiresAt?: string;
  readonly renewalAt?: string;
  readonly signedAt?: string;
}

export interface VerifiedAppStoreServerNotification {
  readonly notificationUUID: string;
  readonly notificationType: string;
  readonly subtype?: string;
  readonly version: string;
  readonly environment: AppStoreEnvironment;
  readonly signedAt: string;
  readonly signedPayloadDigest: string;
  readonly appStoreStatus?: number;
  readonly transaction?: VerifiedStoreKitTransaction;
  readonly renewal?: VerifiedAppStoreRenewal;
}

export interface AppStoreServerNotificationVerifier {
  readonly environment: AppStoreEnvironment;
  verify(signedPayload: string): Promise<VerifiedAppStoreServerNotification>;
}

const compactJwsPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function iso(milliseconds: number | undefined): string | undefined {
  if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0) return undefined;
  const value = new Date(milliseconds);
  return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
}

function requiredTimestamp(milliseconds: number | undefined, field: string): string {
  const value = iso(milliseconds);
  if (value === undefined) throw new DomainError("SUBSCRIPTION_UNVERIFIED", `Verified App Store ${field} is missing or invalid`, 422);
  return value;
}

function compactJws(value: string, field: string): void {
  if (value.length < 32 || value.length > 1_048_576 || !compactJwsPattern.test(value)) {
    throw new DomainError("SUBSCRIPTION_UNVERIFIED", `${field} is not a valid compact JWS`, 422);
  }
}

function requiredIdentifier(value: string | undefined, field: string): string {
  if (value === undefined || value.length < 1 || value.length > 255) {
    throw new DomainError("SUBSCRIPTION_UNVERIFIED", `Verified App Store ${field} is missing or invalid`, 422);
  }
  return value;
}

function requiredEnvironment(value: string | undefined): AppStoreEnvironment {
  if (value !== Environment.SANDBOX && value !== Environment.PRODUCTION) {
    throw new DomainError("SUBSCRIPTION_UNVERIFIED", "Verified App Store environment is invalid", 422);
  }
  return value;
}

function verificationFailure(error: unknown): never {
  if (error instanceof DomainError) throw error;
  if (error instanceof VerificationException && error.status === VerificationStatus.RETRYABLE_VERIFICATION_FAILURE) {
    throw new DomainError(
      "STOREKIT_VERIFICATION_RETRYABLE",
      "Apple certificate status verification is temporarily unavailable",
      503
    );
  }
  throw new DomainError("SUBSCRIPTION_UNVERIFIED", "App Store signed data could not be verified", 422);
}

function normalizedTransaction(
  decoded: JWSTransactionDecodedPayload,
  signedPayload: string
): VerifiedStoreKitTransaction {
  const productID = requiredIdentifier(decoded.productId, "product identifier");
  const transactionID = requiredIdentifier(decoded.transactionId, "transaction identifier");
  const originalTransactionID = requiredIdentifier(decoded.originalTransactionId, "original transaction identifier");
  const environment = requiredEnvironment(decoded.environment);
  if (decoded.type !== Type.AUTO_RENEWABLE_SUBSCRIPTION) {
    throw new DomainError("SUBSCRIPTION_PRODUCT_TYPE_INVALID", "Only auto-renewable subscription transactions are accepted", 422);
  }
  if (decoded.inAppOwnershipType !== InAppOwnershipType.PURCHASED) {
    throw new DomainError("SUBSCRIPTION_OWNERSHIP_INVALID", "The subscription must be purchased by the authenticated App Store account", 422);
  }
  const purchasedAt = requiredTimestamp(decoded.purchaseDate, "purchase date");
  const expiresAt = requiredTimestamp(decoded.expiresDate, "expiration date");
  const signedAt = requiredTimestamp(decoded.signedDate, "signed date");
  const appAccountToken = decoded.appAccountToken === undefined
    ? undefined
    : uuidPattern.test(decoded.appAccountToken) ? decoded.appAccountToken.toLowerCase() : decoded.appAccountToken;
  return Object.freeze({
    productID,
    transactionID,
    originalTransactionID,
    environment,
    signedPayloadDigest: createHash("sha256").update(signedPayload).digest("hex"),
    ...(appAccountToken === undefined ? {} : { appAccountToken }),
    purchasedAt,
    expiresAt,
    ...(iso(decoded.revocationDate) === undefined ? {} : { revokedAt: iso(decoded.revocationDate)! }),
    signedAt
  });
}

function environmentHint(signedPayload: string): AppStoreEnvironment {
  compactJws(signedPayload, "signed transaction");
  try {
    const payload = JSON.parse(Buffer.from(signedPayload.split(".")[1]!, "base64url").toString("utf8")) as {
      environment?: unknown;
    };
    return requiredEnvironment(typeof payload.environment === "string" ? payload.environment : undefined);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError("SUBSCRIPTION_UNVERIFIED", "Signed transaction payload is invalid", 422);
  }
}

/**
 * Splits a PEM bundle downloaded from Apple PKI and converts it to the DER
 * buffers required by Apple's official Node server library.
 */
export function parseAppleRootCertificateBundle(pemBundle: string): readonly Buffer[] {
  const blocks = pemBundle.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (blocks.length === 0) throw new DomainError("STOREKIT_ROOT_CA_REQUIRED", "APPLE_ROOT_CA_BUNDLE must contain Apple root certificates in PEM format", 500);
  const certificates = blocks.map((block) => {
    try {
      const certificate = new X509Certificate(block);
      if (!certificate.ca || !certificate.verify(certificate.publicKey)) {
        throw new Error("certificate is not a self-signed certificate authority");
      }
      return Buffer.from(certificate.raw);
    } catch {
      throw new DomainError("STOREKIT_ROOT_CA_INVALID", "APPLE_ROOT_CA_BUNDLE contains an invalid root certificate", 500);
    }
  });
  return Object.freeze(certificates);
}

export function createAppleSignedDataVerifiers(
  configuration: AppleStoreKitVerifierConfiguration
): ReadonlyMap<AppStoreEnvironment, AppleSignedDataVerifier> {
  if (configuration.rootCertificates.length === 0) throw new DomainError("STOREKIT_ROOT_CA_REQUIRED", "At least one Apple root certificate is required", 500);
  if (!/^[A-Za-z0-9.-]{3,255}$/.test(configuration.bundleId)) throw new DomainError("STOREKIT_BUNDLE_ID_INVALID", "APPLE_BUNDLE_ID is invalid", 500);
  const uniqueEnvironments = new Set(configuration.environments);
  if (uniqueEnvironments.size === 0) throw new DomainError("STOREKIT_ENVIRONMENTS_REQUIRED", "At least one StoreKit environment is required", 500);
  if (uniqueEnvironments.has("Production") && (!Number.isSafeInteger(configuration.appAppleId) || configuration.appAppleId! <= 0)) {
    throw new DomainError("STOREKIT_APP_APPLE_ID_REQUIRED", "APPLE_APP_ID must be a positive integer when Production StoreKit verification is enabled", 500);
  }
  const verifiers = new Map<AppStoreEnvironment, AppleSignedDataVerifier>();
  for (const environment of uniqueEnvironments) {
    const appleEnvironment = environment === "Sandbox" ? Environment.SANDBOX : Environment.PRODUCTION;
    verifiers.set(
      environment,
      new SignedDataVerifier(
        [...configuration.rootCertificates],
        true,
        appleEnvironment,
        configuration.bundleId,
        environment === "Production" ? configuration.appAppleId : undefined
      )
    );
  }
  return verifiers;
}

export class AppleStoreKitTransactionVerifier implements StoreKitTransactionVerifier {
  public constructor(
    private readonly verifiers: ReadonlyMap<AppStoreEnvironment, AppleSignedDataVerifier>
  ) {
    if (verifiers.size === 0) throw new TypeError("At least one Apple signed-data verifier is required");
  }

  public async verify(
    input: StoreKitSyncRequest,
    expectedAppAccountToken?: string
  ): Promise<VerifiedStoreKitTransaction> {
    if (expectedAppAccountToken === undefined || !uuidPattern.test(expectedAppAccountToken)) {
      throw new DomainError("STOREKIT_ACCOUNT_TOKEN_REQUIRED", "An authenticated UUID account token is required for StoreKit synchronization", 503);
    }
    const environment = environmentHint(input.signedTransactionJWS);
    const verifier = this.verifiers.get(environment);
    if (verifier === undefined) throw new DomainError("STOREKIT_ENVIRONMENT_DISABLED", `StoreKit ${environment} verification is not enabled`, 422);
    try {
      const transaction = normalizedTransaction(
        await verifier.verifyAndDecodeTransaction(input.signedTransactionJWS),
        input.signedTransactionJWS
      );
      if (
        transaction.productID !== input.productID ||
        transaction.transactionID !== input.transactionID ||
        transaction.originalTransactionID !== input.originalTransactionID
      ) {
        throw new DomainError("SUBSCRIPTION_UNVERIFIED", "Signed transaction does not match the synchronization request", 422);
      }
      if (transaction.appAccountToken?.toLowerCase() !== expectedAppAccountToken.toLowerCase()) {
        throw new DomainError("STOREKIT_ACCOUNT_TOKEN_MISMATCH", "Signed transaction is not bound to the authenticated WHOX account", 403);
      }
      return transaction;
    } catch (error) {
      return verificationFailure(error);
    }
  }
}

export class AppleStoreKitServerNotificationVerifier implements AppStoreServerNotificationVerifier {
  public constructor(
    public readonly environment: AppStoreEnvironment,
    private readonly verifier: AppleSignedDataVerifier
  ) {}

  public async verify(signedPayload: string): Promise<VerifiedAppStoreServerNotification> {
    compactJws(signedPayload, "notification signedPayload");
    try {
      const decoded = await this.verifier.verifyAndDecodeNotification(signedPayload);
      const environment = requiredEnvironment(decoded.data?.environment ?? decoded.summary?.environment ?? decoded.appData?.environment);
      if (environment !== this.environment) throw new DomainError("STOREKIT_ENVIRONMENT_MISMATCH", "Notification was posted to the wrong StoreKit environment endpoint", 422);
      if (decoded.notificationUUID === undefined || !uuidPattern.test(decoded.notificationUUID)) {
        throw new DomainError("STOREKIT_NOTIFICATION_INVALID", "Verified notification UUID is invalid", 422);
      }
      if (decoded.notificationType === undefined || !/^[A-Z][A-Z0-9_]{1,63}$/.test(decoded.notificationType)) {
        throw new DomainError("STOREKIT_NOTIFICATION_INVALID", "Verified notification type is invalid", 422);
      }
      if (decoded.version === undefined || !/^2(?:\.|$)/.test(decoded.version)) {
        throw new DomainError("STOREKIT_NOTIFICATION_VERSION_UNSUPPORTED", "Only App Store Server Notifications V2 are accepted", 422);
      }
      const signedAt = iso(decoded.signedDate);
      if (signedAt === undefined) throw new DomainError("STOREKIT_NOTIFICATION_INVALID", "Verified notification signed date is invalid", 422);
      let transaction: VerifiedStoreKitTransaction | undefined;
      if (decoded.data?.signedTransactionInfo !== undefined) {
        compactJws(decoded.data.signedTransactionInfo, "signedTransactionInfo");
        transaction = normalizedTransaction(
          await this.verifier.verifyAndDecodeTransaction(decoded.data.signedTransactionInfo),
          decoded.data.signedTransactionInfo
        );
      }
      let renewal: VerifiedAppStoreRenewal | undefined;
      if (decoded.data?.signedRenewalInfo !== undefined) {
        compactJws(decoded.data.signedRenewalInfo, "signedRenewalInfo");
        const value = await this.verifier.verifyAndDecodeRenewalInfo(decoded.data.signedRenewalInfo);
        const originalTransactionID = requiredIdentifier(value.originalTransactionId, "renewal original transaction identifier");
        renewal = Object.freeze({
          originalTransactionID,
          environment: requiredEnvironment(value.environment),
          ...(value.productId === undefined ? {} : { productID: value.productId }),
          ...(value.autoRenewProductId === undefined ? {} : { autoRenewProductID: value.autoRenewProductId }),
          ...(value.appAccountToken === undefined ? {} : { appAccountToken: uuidPattern.test(value.appAccountToken) ? value.appAccountToken.toLowerCase() : value.appAccountToken }),
          ...(value.isInBillingRetryPeriod === undefined ? {} : { isInBillingRetryPeriod: value.isInBillingRetryPeriod }),
          ...(iso(value.gracePeriodExpiresDate) === undefined ? {} : { gracePeriodExpiresAt: iso(value.gracePeriodExpiresDate)! }),
          ...(iso(value.renewalDate) === undefined ? {} : { renewalAt: iso(value.renewalDate)! }),
          ...(iso(value.signedDate) === undefined ? {} : { signedAt: iso(value.signedDate)! })
        });
      }
      if (transaction !== undefined && renewal !== undefined) {
        if (transaction.originalTransactionID !== renewal.originalTransactionID) {
          throw new DomainError("STOREKIT_NOTIFICATION_INCONSISTENT", "Transaction and renewal identifiers do not match", 422);
        }
        if (
          transaction.appAccountToken !== undefined &&
          renewal.appAccountToken !== undefined &&
          transaction.appAccountToken.toLowerCase() !== renewal.appAccountToken.toLowerCase()
        ) {
          throw new DomainError("STOREKIT_NOTIFICATION_INCONSISTENT", "Transaction and renewal account tokens do not match", 422);
        }
      }
      return Object.freeze({
        notificationUUID: decoded.notificationUUID,
        notificationType: decoded.notificationType,
        ...(decoded.subtype === undefined ? {} : { subtype: decoded.subtype }),
        version: decoded.version,
        environment,
        signedAt,
        signedPayloadDigest: createHash("sha256").update(signedPayload).digest("hex"),
        ...(decoded.data?.status === undefined ? {} : { appStoreStatus: decoded.data.status }),
        ...(transaction === undefined ? {} : { transaction }),
        ...(renewal === undefined ? {} : { renewal })
      });
    } catch (error) {
      return verificationFailure(error);
    }
  }
}

export function notificationVerifiers(
  verifiers: ReadonlyMap<AppStoreEnvironment, AppleSignedDataVerifier>
): ReadonlyMap<AppStoreEnvironment, AppStoreServerNotificationVerifier> {
  return new Map(
    [...verifiers].map(([environment, verifier]) => [
      environment,
      new AppleStoreKitServerNotificationVerifier(environment, verifier)
    ])
  );
}
