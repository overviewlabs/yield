import { randomBytes } from "node:crypto";
import { DomainError } from "@whox/contracts";
import { createClient } from "redis";
type RedisClient = ReturnType<typeof createClient>;

export interface CoordinationLock {readonly key:string;readonly ownerToken:string;readonly expiresAt:string;}
export interface RateLimitDecision {readonly allowed:boolean;readonly remaining:number;readonly resetAt:number;}
export interface CoordinationAdapter {
  acquireLock(key:string,ttlMs:number):Promise<CoordinationLock|undefined>;
  releaseLock(lock:CoordinationLock):Promise<boolean>;
  getJson<T>(key:string):Promise<T|undefined>;
  setJson(key:string,value:unknown,ttlMs:number):Promise<void>;
  consumeRateLimit(key:string,maximum:number,windowMs:number,now:number):Promise<RateLimitDecision>;
  healthy():Promise<boolean>;
  close():Promise<void>;
}

export const RELEASE_LOCK_SCRIPT=`if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;
export const SLIDING_RATE_LIMIT_SCRIPT=`redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',ARGV[1]-ARGV[2])
local count=redis.call('ZCARD',KEYS[1])
if count>=tonumber(ARGV[3]) then
  local first=redis.call('ZRANGE',KEYS[1],0,0,'WITHSCORES')
  return {0,count,tonumber(first[2])+tonumber(ARGV[2])}
end
redis.call('ZADD',KEYS[1],ARGV[1],ARGV[4])
redis.call('PEXPIRE',KEYS[1],ARGV[2])
return {1,count+1,tonumber(ARGV[1])+tonumber(ARGV[2])}`;

export class RedisCoordinationAdapter implements CoordinationAdapter {
  private constructor(private readonly client:RedisClient,private readonly prefix:string){}
  public static async connect(url:string,prefix="whox"):Promise<RedisCoordinationAdapter>{if(!/^rediss?:\/\//.test(url))throw new TypeError("REDIS_URL must use redis:// or rediss://");const client=createClient({url});client.on("error",()=>{});await client.connect();return new RedisCoordinationAdapter(client,prefix);}
  #key(kind:string,key:string):string{if(!/^[A-Za-z0-9._:/-]{1,200}$/.test(key))throw new DomainError("COORDINATION_KEY_INVALID","Coordination key is invalid",500);return `${this.prefix}:${kind}:${key}`;}
  public async acquireLock(key:string,ttlMs:number):Promise<CoordinationLock|undefined>{if(!Number.isInteger(ttlMs)||ttlMs<100||ttlMs>600_000)throw new DomainError("LOCK_TTL_INVALID","Lock TTL is invalid",500);const ownerToken=randomBytes(32).toString("base64url");const result=await this.client.set(this.#key("lock",key),ownerToken,{NX:true,PX:ttlMs});return result===null?undefined:Object.freeze({key,ownerToken,expiresAt:new Date(Date.now()+ttlMs).toISOString()});}
  public async releaseLock(lock:CoordinationLock):Promise<boolean>{const result=await this.client.eval(RELEASE_LOCK_SCRIPT,{keys:[this.#key("lock",lock.key)],arguments:[lock.ownerToken]});return Number(result)===1;}
  public async getJson<T>(key:string):Promise<T|undefined>{const raw=await this.client.get(this.#key("cache",key));if(raw===null)return undefined;try{return JSON.parse(raw) as T;}catch{throw new DomainError("CACHE_VALUE_INVALID","Cached JSON is invalid",500);}}
  public async setJson(key:string,value:unknown,ttlMs:number):Promise<void>{if(!Number.isInteger(ttlMs)||ttlMs<100||ttlMs>86_400_000)throw new DomainError("CACHE_TTL_INVALID","Cache TTL is invalid",500);await this.client.set(this.#key("cache",key),JSON.stringify(value),{PX:ttlMs});}
  public async consumeRateLimit(key:string,maximum:number,windowMs:number,now:number):Promise<RateLimitDecision>{if(!Number.isInteger(maximum)||maximum<1||!Number.isInteger(windowMs)||windowMs<100)throw new DomainError("RATE_LIMIT_CONFIGURATION_INVALID","Rate-limit configuration is invalid",500);const member=`${now}:${randomBytes(12).toString("hex")}`;const result=await this.client.eval(SLIDING_RATE_LIMIT_SCRIPT,{keys:[this.#key("rate",key)],arguments:[String(now),String(windowMs),String(maximum),member]});if(!Array.isArray(result)||result.length!==3)throw new DomainError("REDIS_RATE_LIMIT_INVALID","Redis returned an invalid rate-limit result",500);const allowed=Number(result[0])===1;const count=Number(result[1]);const resetAt=Number(result[2]);return Object.freeze({allowed,remaining:Math.max(0,maximum-count),resetAt});}
  public async healthy():Promise<boolean>{try{return await this.client.ping()==="PONG";}catch{return false;}}
  public async close():Promise<void>{if(this.client.isOpen)await this.client.quit();}
}

interface MemoryLock {readonly ownerToken:string;readonly expiresAt:number;}
export class InMemoryCoordinationAdapter implements CoordinationAdapter {
  readonly #locks=new Map<string,MemoryLock>();readonly #cache=new Map<string,{readonly raw:string;readonly expiresAt:number}>();readonly #rates=new Map<string,number[]>();
  public constructor(private readonly clock:()=>number=Date.now){}
  public async acquireLock(key:string,ttlMs:number):Promise<CoordinationLock|undefined>{const now=this.clock();const prior=this.#locks.get(key);if(prior!==undefined&&prior.expiresAt>now)return undefined;const ownerToken=randomBytes(32).toString("base64url");this.#locks.set(key,{ownerToken,expiresAt:now+ttlMs});return Object.freeze({key,ownerToken,expiresAt:new Date(now+ttlMs).toISOString()});}
  public async releaseLock(lock:CoordinationLock):Promise<boolean>{const prior=this.#locks.get(lock.key);if(prior===undefined||prior.expiresAt<=this.clock()||prior.ownerToken!==lock.ownerToken)return false;return this.#locks.delete(lock.key);}
  public async getJson<T>(key:string):Promise<T|undefined>{const record=this.#cache.get(key);if(record===undefined||record.expiresAt<=this.clock()){this.#cache.delete(key);return undefined;}return JSON.parse(record.raw) as T;}
  public async setJson(key:string,value:unknown,ttlMs:number):Promise<void>{this.#cache.set(key,{raw:JSON.stringify(value),expiresAt:this.clock()+ttlMs});}
  public async consumeRateLimit(key:string,maximum:number,windowMs:number,now:number):Promise<RateLimitDecision>{const events=(this.#rates.get(key)??[]).filter((instant)=>instant>now-windowMs);const allowed=events.length<maximum;if(allowed)events.push(now);this.#rates.set(key,events);return Object.freeze({allowed,remaining:Math.max(0,maximum-events.length),resetAt:(events[0]??now)+windowMs});}
  public async healthy():Promise<boolean>{return true;}public async close():Promise<void>{}
}
