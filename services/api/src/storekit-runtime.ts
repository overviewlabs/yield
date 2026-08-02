import { DomainError } from "@whox/contracts";
import type { RuntimeMode } from "@whox/shared-config";
import {
  AppleStoreKitTransactionVerifier,
  createAppleSignedDataVerifiers,
  notificationVerifiers,
  parseAppleRootCertificateBundle,
  type AppStoreEnvironment
} from "./apple-storekit.js";
import {
  PostgresAppStoreServerNotificationRepository,
  StoreKitServerNotificationService,
  type AppStoreServerNotificationHandler
} from "./storekit-notifications.js";
import type { StoreKitTransactionVerifier } from "./storekit.js";
import { environmentValue } from "./environment-value.js";

export interface AppleStoreKitRuntime {
  readonly transactionVerifier: StoreKitTransactionVerifier;
  readonly notificationHandlers: ReadonlyMap<AppStoreEnvironment, AppStoreServerNotificationHandler>;
  healthy(): Promise<boolean>;
  close(): Promise<void>;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environmentValue(environment, name);
  if (value === undefined || value === "") {
    throw new DomainError("STOREKIT_RUNTIME_CONFIGURATION_REQUIRED", `${name} is required for Paper StoreKit verification`, 500);
  }
  return value;
}

function environments(raw: string): readonly AppStoreEnvironment[] {
  const values = raw.split(",");
  if (values.some((value) => value !== value.trim() || !["sandbox", "production"].includes(value))) {
    throw new DomainError("STOREKIT_ENVIRONMENTS_INVALID", "STOREKIT_ENVIRONMENTS must be sandbox, production, or sandbox,production", 500);
  }
  const unique = new Set(values);
  if (unique.size !== values.length || unique.size === 0) {
    throw new DomainError("STOREKIT_ENVIRONMENTS_INVALID", "STOREKIT_ENVIRONMENTS must not be empty or contain duplicates", 500);
  }
  return Object.freeze(values.map((value) => value === "sandbox" ? "Sandbox" : "Production"));
}

/** Demo never instantiates Apple server verification and keeps its local fixture path unchanged. */
export function loadAppleStoreKitRuntime(
  mode: RuntimeMode,
  environment: NodeJS.ProcessEnv = process.env
): AppleStoreKitRuntime | undefined {
  if (mode === "demo") return undefined;
  const databaseUrl = required(environment, "APP_STORE_DATABASE_URL");
  if (databaseUrl === environmentValue(environment, "DATABASE_URL")) {
    throw new DomainError(
      "STOREKIT_DATABASE_CREDENTIAL_NOT_ISOLATED",
      "APP_STORE_DATABASE_URL must use a distinct least-privilege database login",
      500
    );
  }
  const enabledEnvironments = environments(required(environment, "STOREKIT_ENVIRONMENTS"));
  const appIdRaw = environmentValue(environment, "APPLE_APP_ID");
  const appAppleId = appIdRaw === undefined || appIdRaw === "" ? undefined : Number(appIdRaw);
  if (appAppleId !== undefined && (!Number.isSafeInteger(appAppleId) || appAppleId <= 0)) {
    throw new DomainError("STOREKIT_APP_APPLE_ID_INVALID", "APPLE_APP_ID must be a positive integer", 500);
  }
  const signedDataVerifiers = createAppleSignedDataVerifiers({
    rootCertificates: parseAppleRootCertificateBundle(required(environment, "APPLE_ROOT_CA_BUNDLE")),
    bundleId: required(environment, "APPLE_BUNDLE_ID"),
    environments: enabledEnvironments,
    ...(appAppleId === undefined ? {} : { appAppleId })
  });
  const repository = new PostgresAppStoreServerNotificationRepository(databaseUrl);
  const handlers = new Map<AppStoreEnvironment, AppStoreServerNotificationHandler>();
  for (const [target, verifier] of notificationVerifiers(signedDataVerifiers)) {
    handlers.set(target, new StoreKitServerNotificationService(verifier, repository));
  }
  return Object.freeze({
    transactionVerifier: new AppleStoreKitTransactionVerifier(signedDataVerifiers),
    notificationHandlers: handlers,
    async healthy(): Promise<boolean> { return await repository.healthy(); },
    async close(): Promise<void> { await repository.close(); }
  });
}
