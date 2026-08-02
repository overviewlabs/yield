import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DomainError } from "@whox/contracts";
import type { OAuthTokenSet } from "./oauth.js";

export interface EncryptedTokenEnvelope {
  readonly keyId:string; readonly algorithm:"A256GCM"; readonly iv:string; readonly ciphertext:string; readonly authTag:string;
  readonly connectionId:string; readonly userId:string; readonly createdAt:string;
}

export interface TokenKeyProvider { getEncryptionKey(keyId:string):Promise<Buffer>; currentKeyId():Promise<string>; }

export class StaticTokenKeyProvider implements TokenKeyProvider {
  public constructor(private readonly keyId:string,private readonly key:Buffer){if(key.length!==32)throw new TypeError("Token key must be 32 bytes");}
  public async getEncryptionKey(keyId:string):Promise<Buffer>{if(keyId!==this.keyId)throw new DomainError("TOKEN_KEY_UNAVAILABLE","Token encryption key is unavailable",500);return Buffer.from(this.key);}
  public async currentKeyId():Promise<string>{return this.keyId;}
}

export class TokenVault {
  public constructor(private readonly keys:TokenKeyProvider){}
  public async seal(userId:string,connectionId:string,tokens:OAuthTokenSet,createdAt:string):Promise<EncryptedTokenEnvelope>{
    const keyId=await this.keys.currentKeyId();const key=await this.keys.getEncryptionKey(keyId);const iv=randomBytes(12);
    let plaintext:Buffer|undefined;
    try{const cipher=createCipheriv("aes-256-gcm",key,iv);cipher.setAAD(Buffer.from(`${userId}:${connectionId}:${keyId}`));
      plaintext=Buffer.from(JSON.stringify(tokens));const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);const authTag=cipher.getAuthTag();
      return Object.freeze({keyId,algorithm:"A256GCM",iv:iv.toString("base64url"),ciphertext:ciphertext.toString("base64url"),authTag:authTag.toString("base64url"),connectionId,userId,createdAt});
    }finally{plaintext?.fill(0);key.fill(0);}
  }
  public async open(envelope:EncryptedTokenEnvelope,expectedUserId:string):Promise<OAuthTokenSet>{
    if(envelope.userId!==expectedUserId)throw new DomainError("TOKEN_TENANT_MISMATCH","Token envelope does not belong to this user",403);
    const key=await this.keys.getEncryptionKey(envelope.keyId);
    let plaintext:Buffer|undefined;
    try{const decipher=createDecipheriv("aes-256-gcm",key,Buffer.from(envelope.iv,"base64url"));decipher.setAAD(Buffer.from(`${envelope.userId}:${envelope.connectionId}:${envelope.keyId}`));decipher.setAuthTag(Buffer.from(envelope.authTag,"base64url"));
      plaintext=Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,"base64url")),decipher.final()]);const value:unknown=JSON.parse(plaintext.toString("utf8"));
      if(typeof value!=="object"||value===null||!("accessToken" in value))throw new Error("invalid token payload");return value as OAuthTokenSet;
    }catch{throw new DomainError("TOKEN_DECRYPTION_FAILED","Broker credential could not be decrypted",500);}finally{plaintext?.fill(0);key.fill(0);}
  }
}
