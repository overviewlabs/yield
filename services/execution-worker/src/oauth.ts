import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { DomainError } from "@whox/contracts";

export interface ProtectedResourceMetadata {
  readonly resource: string;
  readonly authorization_servers: readonly string[];
  readonly scopes_supported?: readonly string[];
  readonly bearer_methods_supported?: readonly string[];
}

export interface AuthorizationServerMetadata {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly registration_endpoint?: string;
  readonly revocation_endpoint?: string;
  readonly code_challenge_methods_supported?: readonly string[];
  readonly grant_types_supported?: readonly string[];
  readonly response_types_supported: readonly string[];
  readonly authorization_response_iss_parameter_supported?: boolean;
}

export interface OAuthDiscovery {
  readonly resource: ProtectedResourceMetadata;
  readonly authorizationServer: AuthorizationServerMetadata;
  readonly challengedScope?: string;
}

export interface PendingAuthorization {
  readonly userId: string;
  readonly pairingId: string;
  readonly stateDigest: string;
  readonly nonceDigest: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly resource: string;
  readonly issuer: string;
  readonly expiresAt: string;
  readonly consumedAt?: string;
}

export interface PendingAuthorizationStore {
  put(state: PendingAuthorization): Promise<void>;
  take(state: string, now: string): Promise<PendingAuthorization>;
}

export class InMemoryPendingAuthorizationStore implements PendingAuthorizationStore {
  readonly #byDigest = new Map<string, PendingAuthorization>();
  public async put(value: PendingAuthorization): Promise<void> { this.#byDigest.set(value.stateDigest, value); }
  public async take(state: string, now: string): Promise<PendingAuthorization> {
    const digest = sha256(state);
    const value = this.#byDigest.get(digest);
    if (value === undefined || value.consumedAt !== undefined || Date.parse(value.expiresAt) <= Date.parse(now)) {
      throw new DomainError("OAUTH_STATE_INVALID", "Authorization state is invalid or expired", 400);
    }
    this.#byDigest.delete(digest);
    return Object.freeze({...value,consumedAt:now});
  }
}

const base64url = (value: Uint8Array): string => Buffer.from(value).toString("base64url");
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

function secureUrl(value: string, label: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new DomainError("OAUTH_METADATA_INVALID", `${label} is not a valid URL`, 502); }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new DomainError("OAUTH_METADATA_INVALID", `${label} must be an HTTPS URL without credentials or fragment`, 502);
  }
  return url;
}

export function protectedResourceMetadataUrl(resource: URL): URL {
  const path = resource.pathname === "/" ? "" : resource.pathname.replace(/^\//, "");
  const result = new URL(resource.origin);
  result.pathname = path === "" ? "/.well-known/oauth-protected-resource" : `/.well-known/oauth-protected-resource/${path}`;
  return result;
}

export function authorizationServerMetadataUrl(issuer: URL): URL {
  const result = new URL(issuer.origin);
  const issuerPath = issuer.pathname === "/" ? "" : issuer.pathname.replace(/^\//, "");
  result.pathname = issuerPath === "" ? "/.well-known/oauth-authorization-server" : `/.well-known/oauth-authorization-server/${issuerPath}`;
  return result;
}

export function authorizationServerMetadataUrls(issuer: URL): readonly URL[] {
  const insertedOAuth=authorizationServerMetadataUrl(issuer);
  const issuerPath=issuer.pathname==="/"?"":issuer.pathname.replace(/^\//,"");
  const insertedOidc=new URL(issuer.origin);
  insertedOidc.pathname=issuerPath===""?"/.well-known/openid-configuration":`/.well-known/openid-configuration/${issuerPath}`;
  if(issuerPath==="")return Object.freeze([insertedOAuth,insertedOidc]);
  const appendedOidc=new URL(issuer.href.endsWith("/")?issuer.href:`${issuer.href}/`);
  appendedOidc.pathname=`${appendedOidc.pathname}.well-known/openid-configuration`;
  return Object.freeze([insertedOAuth,insertedOidc,appendedOidc]);
}

export interface WwwAuthenticateChallenge {readonly resourceMetadataUrl?:URL;readonly scope?:string;}
export function parseWwwAuthenticate(value:string|undefined):WwwAuthenticateChallenge {
  if(value===undefined||!/(?:^|,)\s*Bearer\s/i.test(value)&&!/^Bearer\s/i.test(value))return Object.freeze({});
  const resourceMatch=/\bresource_metadata\s*=\s*"([^"]+)"/i.exec(value);
  const scopeMatch=/\bscope\s*=\s*"([^"]*)"/i.exec(value);
  return Object.freeze({
    ...(resourceMatch?.[1]===undefined?{}:{resourceMetadataUrl:secureUrl(resourceMatch[1],"resource metadata URL")}),
    ...(scopeMatch?.[1]===undefined||scopeMatch[1].trim()===""?{}:{scope:scopeMatch[1].trim()})
  });
}

function exactRedirectUrl(value:string):URL {
  let url:URL;try{url=new URL(value);}catch{throw new DomainError("OAUTH_REDIRECT_URI_INVALID","Redirect URI is invalid",400);}
  const loopback=url.hostname==="localhost"||url.hostname==="127.0.0.1"||url.hostname==="[::1]"||url.hostname==="::1";
  if(url.username!==""||url.password!==""||url.hash!==""||(url.protocol!=="https:"&&!(url.protocol==="http:"&&loopback))){
    throw new DomainError("OAUTH_REDIRECT_URI_INVALID","Redirect URI must use HTTPS or exact loopback HTTP without credentials or fragment",400);
  }
  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function strings(value: unknown): readonly string[] | undefined { return Array.isArray(value) && value.every((item)=>typeof item === "string") ? value : undefined; }

export class McpOAuthClient {
  public constructor(
    private readonly fetcher: typeof fetch,
    private readonly expectedResource: URL,
    private readonly clientId: string,
    private readonly allowedRedirectUris: ReadonlySet<string>,
    private readonly pendingStore: PendingAuthorizationStore
  ) {}

  public async discover(input:Readonly<{wwwAuthenticate?:string}>={}): Promise<OAuthDiscovery> {
    const challenge=parseWwwAuthenticate(input.wwwAuthenticate);
    if(challenge.resourceMetadataUrl!==undefined&&challenge.resourceMetadataUrl.origin!==this.expectedResource.origin){
      throw new DomainError("OAUTH_METADATA_ORIGIN_INVALID","Protected-resource metadata URL must share the MCP resource origin",502);
    }
    const pathUrl=protectedResourceMetadataUrl(this.expectedResource);const rootUrl=new URL("/.well-known/oauth-protected-resource",this.expectedResource.origin);
    const candidates=[...(challenge.resourceMetadataUrl===undefined?[]:[challenge.resourceMetadataUrl]),pathUrl,...(rootUrl.href===pathUrl.href?[]:[rootUrl])];
    let response:Response|undefined;
    for(const metadataUrl of candidates){const candidate=await this.fetcher(metadataUrl,{headers:{accept:"application/json"},redirect:"error"});if(candidate.ok){response=candidate;break;}if(candidate.status!==404&&candidate.status!==400)throw new DomainError("OAUTH_RESOURCE_DISCOVERY_FAILED", "Protected-resource metadata discovery failed", 502);}
    if(response===undefined)throw new DomainError("OAUTH_RESOURCE_DISCOVERY_FAILED","Protected-resource metadata was not found at challenge, path, or root locations",502);
    const value: unknown = await response.json();
    if (!isRecord(value)) throw new DomainError("OAUTH_METADATA_INVALID", "Protected-resource metadata is invalid", 502);
    const resourceUrl = secureUrl(String(value.resource ?? ""),"resource");
    if (resourceUrl.href !== this.expectedResource.href) throw new DomainError("OAUTH_RESOURCE_MISMATCH", "Protected resource identifier does not match the configured MCP endpoint", 502);
    const servers = strings(value.authorization_servers);
    if (servers === undefined || servers.length === 0) throw new DomainError("OAUTH_METADATA_INVALID", "No authorization server is advertised", 502);
    const issuer = secureUrl(servers[0]!,"authorization server");
    let asResponse:Response|undefined;
    for(const metadataUrl of authorizationServerMetadataUrls(issuer)){const candidate=await this.fetcher(metadataUrl,{headers:{accept:"application/json"},redirect:"error"});if(candidate.ok){asResponse=candidate;break;}if(candidate.status!==404&&candidate.status!==400)throw new DomainError("OAUTH_SERVER_DISCOVERY_FAILED","Authorization-server metadata discovery failed",502);}
    if(asResponse===undefined)throw new DomainError("OAUTH_SERVER_DISCOVERY_FAILED","Neither OAuth nor OpenID Connect authorization metadata was found",502);
    const serverValue: unknown = await asResponse.json();
    if (!isRecord(serverValue)) throw new DomainError("OAUTH_METADATA_INVALID", "Authorization-server metadata is invalid", 502);
    const discoveredIssuer=secureUrl(String(serverValue.issuer ?? ""),"issuer");
    if(discoveredIssuer.href!==issuer.href) throw new DomainError("OAUTH_ISSUER_MISMATCH","Authorization-server issuer mismatch",502);
    const authorizationEndpoint=secureUrl(String(serverValue.authorization_endpoint ?? ""),"authorization endpoint");
    const tokenEndpoint=secureUrl(String(serverValue.token_endpoint ?? ""),"token endpoint");
    const responseTypes=strings(serverValue.response_types_supported);
    if(responseTypes===undefined||!responseTypes.includes("code")) throw new DomainError("OAUTH_METADATA_INVALID","Authorization code flow is not supported",502);
    const methods=strings(serverValue.code_challenge_methods_supported);
    if(methods===undefined||!methods.includes("S256")) throw new DomainError("OAUTH_PKCE_UNSUPPORTED","Authorization server must advertise PKCE S256",502);
    const authorizationServer:AuthorizationServerMetadata=Object.freeze({
      issuer:discoveredIssuer.href,authorization_endpoint:authorizationEndpoint.href,token_endpoint:tokenEndpoint.href,response_types_supported:responseTypes,
      ...(typeof serverValue.registration_endpoint === "string" ? {registration_endpoint:secureUrl(serverValue.registration_endpoint,"registration endpoint").href}:{}),
      ...(typeof serverValue.revocation_endpoint === "string" ? {revocation_endpoint:secureUrl(serverValue.revocation_endpoint,"revocation endpoint").href}:{}),
      ...(methods===undefined?{}:{code_challenge_methods_supported:methods}),
      ...(strings(serverValue.grant_types_supported)===undefined?{}:{grant_types_supported:strings(serverValue.grant_types_supported)!}),
      ...(typeof serverValue.authorization_response_iss_parameter_supported==="boolean"?{authorization_response_iss_parameter_supported:serverValue.authorization_response_iss_parameter_supported}:{})
    });
    const resource:ProtectedResourceMetadata=Object.freeze({resource:resourceUrl.href,authorization_servers:Object.freeze([...servers]),
      ...(strings(value.scopes_supported)===undefined?{}:{scopes_supported:strings(value.scopes_supported)!}),
      ...(strings(value.bearer_methods_supported)===undefined?{}:{bearer_methods_supported:strings(value.bearer_methods_supported)!})});
    return Object.freeze({resource,authorizationServer,...(challenge.scope===undefined?{}:{challengedScope:challenge.scope})});
  }

  public async begin(
    discovery:OAuthDiscovery,
    input:{readonly userId:string;readonly pairingId:string;readonly redirectUri:string;readonly scope?:string;readonly now:string}
  ):Promise<{readonly authorizationUrl:string;readonly state:string;readonly nonce:string}> {
    if(!this.allowedRedirectUris.has(input.redirectUri)) throw new DomainError("OAUTH_REDIRECT_URI_INVALID","Redirect URI is not exactly registered",400);
    const redirect=exactRedirectUrl(input.redirectUri);
    const verifier=base64url(randomBytes(48)); const challenge=base64url(createHash("sha256").update(verifier).digest());
    const state=base64url(randomBytes(32)); const nonce=base64url(randomBytes(32)); const now=Date.parse(input.now);
    const pending:PendingAuthorization=Object.freeze({userId:input.userId,pairingId:input.pairingId,stateDigest:sha256(state),nonceDigest:sha256(nonce),
      codeVerifier:verifier,redirectUri:redirect.href,resource:discovery.resource.resource,issuer:discovery.authorizationServer.issuer,
      expiresAt:new Date(now+10*60_000).toISOString()});
    await this.pendingStore.put(pending);
    const url=new URL(discovery.authorizationServer.authorization_endpoint);
    url.searchParams.set("response_type","code"); url.searchParams.set("client_id",this.clientId); url.searchParams.set("redirect_uri",redirect.href);
    url.searchParams.set("code_challenge",challenge); url.searchParams.set("code_challenge_method","S256"); url.searchParams.set("state",state);
    url.searchParams.set("nonce",nonce); url.searchParams.set("resource",discovery.resource.resource);
    const requestedScope=input.scope??discovery.challengedScope??discovery.resource.scopes_supported?.join(" ");
    if(requestedScope!==undefined&&requestedScope!=="")url.searchParams.set("scope",requestedScope);
    return Object.freeze({authorizationUrl:url.href,state,nonce});
  }

  public async exchange(
    discovery:OAuthDiscovery,
    input:{readonly code:string;readonly state:string;readonly now:string;readonly issuer?:string}
  ):Promise<{readonly tokens:OAuthTokenSet;readonly pending:PendingAuthorization}> {
    const pending=await this.pendingStore.take(input.state,input.now);
    if(pending.issuer!==discovery.authorizationServer.issuer||pending.resource!==discovery.resource.resource) throw new DomainError("OAUTH_CONTEXT_MISMATCH","OAuth discovery context changed",400);
    const issuerRequired=discovery.authorizationServer.authorization_response_iss_parameter_supported===true;
    if((issuerRequired&&input.issuer===undefined)||(input.issuer!==undefined&&input.issuer!==pending.issuer))throw new DomainError("OAUTH_ISSUER_MISMATCH","Authorization response issuer mismatch",400);
    const body=new URLSearchParams({grant_type:"authorization_code",code:input.code,redirect_uri:pending.redirectUri,client_id:this.clientId,
      code_verifier:pending.codeVerifier,resource:pending.resource});
    const response=await this.fetcher(discovery.authorizationServer.token_endpoint,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded","accept":"application/json"},body,redirect:"error"});
    if(!response.ok) throw new DomainError("OAUTH_TOKEN_EXCHANGE_FAILED","Authorization code exchange failed",502);
    return Object.freeze({tokens:parseTokenSet(await response.json(),input.now,pending.resource),pending});
  }

  public async refresh(discovery:OAuthDiscovery,current:OAuthTokenSet,now:string):Promise<OAuthTokenSet>{
    if(current.refreshToken===undefined)throw new DomainError("OAUTH_REAUTHENTICATION_REQUIRED","No refresh token was issued; reconnect is required",401);
    if(current.resource!==discovery.resource.resource)throw new DomainError("OAUTH_CONTEXT_MISMATCH","Refresh token resource does not match the MCP resource",400);
    const body=new URLSearchParams({grant_type:"refresh_token",refresh_token:current.refreshToken,client_id:this.clientId,resource:current.resource});if(current.scope!==undefined)body.set("scope",current.scope);
    const response=await this.fetcher(discovery.authorizationServer.token_endpoint,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded",accept:"application/json"},body,redirect:"error"});
    if(!response.ok)throw new DomainError(response.status===400||response.status===401?"OAUTH_REAUTHENTICATION_REQUIRED":"OAUTH_TOKEN_REFRESH_FAILED","Broker authorization refresh failed",response.status===400||response.status===401?401:502);
    const refreshed=parseTokenSet(await response.json(),now,current.resource);return Object.freeze({...refreshed,...(refreshed.refreshToken===undefined?{refreshToken:current.refreshToken}:{})});
  }

  public async revoke(discovery:OAuthDiscovery,token:string,tokenTypeHint:"access_token"|"refresh_token"):Promise<boolean>{
    const endpoint=discovery.authorizationServer.revocation_endpoint;if(endpoint===undefined)return false;
    const body=new URLSearchParams({token,token_type_hint:tokenTypeHint,client_id:this.clientId});const response=await this.fetcher(endpoint,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body,redirect:"error"});
    if(!response.ok)throw new DomainError("OAUTH_TOKEN_REVOCATION_FAILED","Broker token revocation failed",502);return true;
  }
}

export interface OAuthTokenSet {readonly accessToken:string;readonly tokenType:"Bearer";readonly expiresAt:string;readonly scope?:string;readonly refreshToken?:string;readonly resource:string;}

export function parseTokenSet(value:unknown,now:string,resource:string):OAuthTokenSet {
  if(!isRecord(value)||typeof value.access_token!=="string"||value.access_token.length<8)throw new DomainError("OAUTH_TOKEN_RESPONSE_INVALID","Token response is invalid",502);
  if(typeof value.token_type!=="string"||value.token_type.toLowerCase()!=="bearer")throw new DomainError("OAUTH_TOKEN_RESPONSE_INVALID","Only Bearer tokens are supported",502);
  const expiresIn=typeof value.expires_in==="number"&&Number.isFinite(value.expires_in)&&value.expires_in>0?value.expires_in:300;
  validateObservableTokenAudience(value.access_token,resource);
  return Object.freeze({accessToken:value.access_token,tokenType:"Bearer",expiresAt:new Date(Date.parse(now)+expiresIn*1000).toISOString(),resource,
    ...(typeof value.scope==="string"?{scope:value.scope}:{}),...(typeof value.refresh_token==="string"?{refreshToken:value.refresh_token}:{})});
}

export function validateObservableTokenAudience(accessToken:string,resource:string):void {
  const parts=accessToken.split(".");if(parts.length!==3)return;
  let payload:unknown;try{payload=JSON.parse(Buffer.from(parts[1]!,"base64url").toString("utf8"));}catch{throw new DomainError("OAUTH_TOKEN_RESPONSE_INVALID","JWT access token payload is invalid",502);}
  if(!isRecord(payload)||payload.aud===undefined)return;
  const audiences=typeof payload.aud==="string"?[payload.aud]:strings(payload.aud);
  if(audiences===undefined||!audiences.includes(resource))throw new DomainError("OAUTH_TOKEN_AUDIENCE_INVALID","Access token is not bound to the MCP resource",502);
}

export function tokenNeedsRefresh(tokens:OAuthTokenSet,now:string,skewSeconds=60):boolean {const instant=Date.parse(now);if(!Number.isFinite(instant)||!Number.isFinite(Date.parse(tokens.expiresAt)))throw new DomainError("OAUTH_TOKEN_RESPONSE_INVALID","Token expiration timestamp is invalid",500);return Date.parse(tokens.expiresAt)<=instant+skewSeconds*1000;}

export function constantTimeDigestMatches(value:string,expectedDigest:string):boolean {
  const actual=Buffer.from(sha256(value)); const expected=Buffer.from(expectedDigest);
  return actual.length===expected.length&&timingSafeEqual(actual,expected);
}
