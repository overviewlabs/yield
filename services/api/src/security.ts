import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { DomainError } from "@whox/contracts";

const encode=(value:unknown):string=>Buffer.from(JSON.stringify(value)).toString("base64url");
const digest=(value:string):string=>createHash("sha256").update(value).digest("hex");

export interface AccessClaims {readonly sub:string;readonly sessionId:string;readonly deviceId:string;readonly iat:number;readonly exp:number;readonly kind:"access";}
export interface AuthTokens {readonly accessToken:string;readonly accessExpiresAt:string;readonly refreshToken:string;readonly refreshExpiresAt:string;readonly sessionId:string;}
interface SessionRecord {readonly sessionId:string;readonly userId:string;readonly deviceId:string;refreshDigest:string;readonly createdAt:string;refreshExpiresAt:string;revokedAt?:string;}

export interface SessionService {
  readonly persistenceKind:"ephemeral"|"persistent";
  create(userId:string,deviceId:string,now?:Date):AuthTokens|Promise<AuthTokens>;
  verify(accessToken:string,now?:Date):AccessClaims|Promise<AccessClaims>;
  rotate(sessionId:string,refreshToken:string,now?:Date):AuthTokens|Promise<AuthTokens>;
  revoke(sessionId:string,now?:Date,userId?:string):void|Promise<void>;
  list(userId:string):readonly Readonly<Record<string,unknown>>[]|Promise<readonly Readonly<Record<string,unknown>>[]>;
  healthy():boolean|Promise<boolean>;
}

export class SessionManager {
  public readonly persistenceKind:"ephemeral"|"persistent"="ephemeral";
  readonly #sessions=new Map<string,SessionRecord>();
  public constructor(private readonly signingKey:Buffer){if(signingKey.length<32)throw new TypeError("AUTH_SIGNING_KEY must contain at least 32 bytes");}
  #sign(data:string):string{return createHmac("sha256",this.signingKey).update(data).digest("base64url");}
  #jwt(claims:AccessClaims):string{const data=`${encode({alg:"HS256",typ:"JWT"})}.${encode(claims)}`;return `${data}.${this.#sign(data)}`;}
  #issue(session:SessionRecord,now:Date):AuthTokens{const accessExp=new Date(now.getTime()+15*60_000);const refreshExp=new Date(now.getTime()+30*24*60*60_000);const refreshToken=randomBytes(48).toString("base64url");session.refreshDigest=digest(refreshToken);session.refreshExpiresAt=refreshExp.toISOString();
    return Object.freeze({accessToken:this.#jwt({sub:session.userId,sessionId:session.sessionId,deviceId:session.deviceId,iat:Math.floor(now.getTime()/1000),exp:Math.floor(accessExp.getTime()/1000),kind:"access"}),accessExpiresAt:accessExp.toISOString(),refreshToken,refreshExpiresAt:refreshExp.toISOString(),sessionId:session.sessionId});}
  public create(userId:string,deviceId:string,now=new Date()):AuthTokens{const session:SessionRecord={sessionId:randomUUID(),userId,deviceId,refreshDigest:"",createdAt:now.toISOString(),refreshExpiresAt:now.toISOString()};this.#sessions.set(session.sessionId,session);return this.#issue(session,now);}
  public verify(accessToken:string,now=new Date()):AccessClaims{const parts=accessToken.split(".");if(parts.length!==3)throw new DomainError("AUTH_INVALID","Session token is invalid",401);const data=`${parts[0]}.${parts[1]}`;const expected=Buffer.from(this.#sign(data));const received=Buffer.from(parts[2]!);if(expected.length!==received.length||!timingSafeEqual(expected,received))throw new DomainError("AUTH_INVALID","Session token is invalid",401);
    let header:unknown;let claims:unknown;try{header=JSON.parse(Buffer.from(parts[0]!,"base64url").toString("utf8"));claims=JSON.parse(Buffer.from(parts[1]!,"base64url").toString("utf8"));}catch{throw new DomainError("AUTH_INVALID","Session token is invalid",401);}
    if(typeof header!=="object"||header===null||(header as Record<string,unknown>).alg!=="HS256"||(header as Record<string,unknown>).typ!=="JWT")throw new DomainError("AUTH_INVALID","Session token header is invalid",401);
    if(typeof claims!=="object"||claims===null)throw new DomainError("AUTH_INVALID","Session token claims are invalid",401);const candidate=claims as Record<string,unknown>;
    if(typeof candidate.sub!=="string"||typeof candidate.sessionId!=="string"||typeof candidate.deviceId!=="string"||typeof candidate.iat!=="number"||typeof candidate.exp!=="number"||candidate.kind!=="access"||!Number.isInteger(candidate.iat)||!Number.isInteger(candidate.exp))throw new DomainError("AUTH_INVALID","Session token claims are invalid",401);
    const typed=candidate as unknown as AccessClaims;const nowSeconds=Math.floor(now.getTime()/1000);const session=this.#sessions.get(typed.sessionId);
    if(session===undefined||session.revokedAt!==undefined||session.userId!==typed.sub||session.deviceId!==typed.deviceId||typed.exp<=nowSeconds||typed.iat>nowSeconds+30||typed.exp-typed.iat>15*60)throw new DomainError("AUTH_EXPIRED","Session is expired or revoked",401);return Object.freeze(typed);}
  public rotate(sessionId:string,refreshToken:string,now=new Date()):AuthTokens{const session=this.#sessions.get(sessionId);if(session===undefined||session.revokedAt!==undefined||Date.parse(session.refreshExpiresAt)<=now.getTime())throw new DomainError("REFRESH_INVALID","Refresh token is invalid",401);const expected=Buffer.from(session.refreshDigest);const actual=Buffer.from(digest(refreshToken));if(expected.length!==actual.length||!timingSafeEqual(expected,actual))throw new DomainError("REFRESH_REPLAYED","Refresh token is invalid or already rotated",401);return this.#issue(session,now);}
  public revoke(sessionId:string,now=new Date(),_userId?:string):void{const session=this.#sessions.get(sessionId);if(session!==undefined)session.revokedAt=now.toISOString();}
  public list(userId:string):readonly Readonly<Omit<SessionRecord,"refreshDigest">>[] {return Object.freeze([...this.#sessions.values()].filter((item)=>item.userId===userId).map(({refreshDigest:_,...safe})=>Object.freeze(safe)));}
  public healthy():boolean{return true;}
}

export interface AppleIdentity {readonly appleSubject:string;readonly email?:string;readonly emailVerified:boolean;readonly displayName?:string;readonly assertionDigest?:string;readonly assertionExpiresAt?:string;}
export interface AppleIdentityVerificationContext {readonly nonce?:string;readonly now?:Date;}
export interface AppleIdentityVerifier {verify(identityToken:string,context?:AppleIdentityVerificationContext):Promise<AppleIdentity>;}
export class DevelopmentAppleIdentityVerifier implements AppleIdentityVerifier {
  public constructor(private readonly enabled:boolean){}
  public async verify(identityToken:string,_context?:AppleIdentityVerificationContext):Promise<AppleIdentity>{if(!this.enabled||identityToken!=="demo-apple-identity-token")throw new DomainError("APPLE_IDENTITY_INVALID","Apple identity verification failed",401);return Object.freeze({appleSubject:"demo.apple.subject",email:"review@whox.example",emailVerified:true});}
}

export class CsrfManager {
  readonly #tokens=new Map<string,{readonly digest:string;readonly expiresAt:number}>();
  public issue(sessionId:string,now=Date.now()):string{const token=randomBytes(32).toString("base64url");this.#tokens.set(sessionId,{digest:digest(token),expiresAt:now+60*60_000});return token;}
  public verify(sessionId:string,token:string|undefined,now=Date.now()):void{const record=this.#tokens.get(sessionId);if(token===undefined||record===undefined||record.expiresAt<=now){throw new DomainError("CSRF_INVALID","CSRF token is missing or expired",403);}const expected=Buffer.from(record.digest);const actual=Buffer.from(digest(token));if(expected.length!==actual.length||!timingSafeEqual(expected,actual))throw new DomainError("CSRF_INVALID","CSRF token is invalid",403);}
}

export class SlidingWindowRateLimiter {
  readonly #events=new Map<string,number[]>();public constructor(private readonly maximum:number,private readonly windowMs:number){}
  public consume(key:string,now=Date.now()):{readonly remaining:number;readonly resetAt:number}{const cutoff=now-this.windowMs;const events=(this.#events.get(key)??[]).filter((instant)=>instant>cutoff);if(events.length>=this.maximum)throw new DomainError("RATE_LIMITED","Too many requests; try again later",429,{retryAfterSeconds:Math.ceil((events[0]!+this.windowMs-now)/1000)});events.push(now);this.#events.set(key,events);return Object.freeze({remaining:this.maximum-events.length,resetAt:events[0]!+this.windowMs});}
}
