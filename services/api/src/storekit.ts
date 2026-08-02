import { createHmac, timingSafeEqual } from "node:crypto";
import { DomainError } from "@whox/contracts";

export interface StoreKitSyncRequest {readonly productID:string;readonly transactionID:string;readonly originalTransactionID:string;readonly signedTransactionJWS:string;}
export interface VerifiedStoreKitTransaction {
  readonly productID:string;
  readonly transactionID:string;
  readonly originalTransactionID:string;
  readonly environment:"Xcode"|"Sandbox"|"Production";
  readonly signedPayloadDigest?:string;
  readonly appAccountToken?:string;
  readonly purchasedAt?:string;
  readonly expiresAt?:string;
  readonly revokedAt?:string;
  readonly signedAt?:string;
}
export interface StoreKitTransactionVerifier {verify(input:StoreKitSyncRequest,expectedAppAccountToken?:string):Promise<VerifiedStoreKitTransaction>;}

export class UnavailableStoreKitTransactionVerifier implements StoreKitTransactionVerifier {
  public async verify():Promise<VerifiedStoreKitTransaction>{throw new DomainError("STOREKIT_VERIFIER_UNAVAILABLE","StoreKit server verification is not configured",503);}
}

export class DevelopmentStoreKitTransactionVerifier implements StoreKitTransactionVerifier {
  public constructor(private readonly signingKey:Buffer){if(signingKey.length<32)throw new TypeError("Demo StoreKit signing key must contain at least 32 bytes");}
  public async verify(input:StoreKitSyncRequest):Promise<VerifiedStoreKitTransaction>{const parts=input.signedTransactionJWS.split(".");if(parts.length!==3)throw new DomainError("SUBSCRIPTION_UNVERIFIED","Signed StoreKit transaction is invalid",422);const signingInput=`${parts[0]}.${parts[1]}`;const expected=createHmac("sha256",this.signingKey).update(signingInput).digest();let received:Buffer;let header:unknown;let payload:unknown;try{received=Buffer.from(parts[2]!,"base64url");header=JSON.parse(Buffer.from(parts[0]!,"base64url").toString("utf8"));payload=JSON.parse(Buffer.from(parts[1]!,"base64url").toString("utf8"));}catch{throw new DomainError("SUBSCRIPTION_UNVERIFIED","Signed StoreKit transaction is invalid",422);}if(expected.length!==received.length||!timingSafeEqual(expected,received))throw new DomainError("SUBSCRIPTION_UNVERIFIED","Signed StoreKit transaction is invalid",422);
    if(typeof header!=="object"||header===null||(header as Record<string,unknown>).alg!=="HS256"||(header as Record<string,unknown>).typ!=="JWT"||typeof payload!=="object"||payload===null)throw new DomainError("SUBSCRIPTION_UNVERIFIED","Demo transaction header or payload is invalid",422);const value=payload as Record<string,unknown>;
    if(value.productID!==input.productID||value.transactionID!==input.transactionID||value.originalTransactionID!==input.originalTransactionID||value.environment!=="Xcode")throw new DomainError("SUBSCRIPTION_UNVERIFIED","Signed transaction does not match the synchronization request",422);
    return Object.freeze({productID:input.productID,transactionID:input.transactionID,originalTransactionID:input.originalTransactionID,environment:"Xcode"});}
}
