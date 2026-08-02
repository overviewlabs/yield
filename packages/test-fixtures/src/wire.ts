export const AUTH_SESSION_RESPONSE_FIXTURE = Object.freeze({
  userID:"10000000-0000-4000-8000-000000000001",displayName:"Treasury Reviewer",email:"review@whox.example",
  accessToken:"fixture.access.token",accessTokenExpiresAt:"2026-08-01T14:15:00.000Z",refreshToken:"fixture-refresh-token",
  refreshTokenExpiresAt:"2026-08-31T14:00:00.000Z",sessionID:"90000000-0000-4000-8000-000000000001"
});

export const PAIRING_RESPONSE_FIXTURE = Object.freeze({
  pairingId:"91000000-0000-4000-8000-000000000001",code:"SAFE-482K",setupUrl:"https://connect.whox.ai/pair?pairing_code=SAFE-482K",
  expiresAt:"2026-08-01T14:10:00.000Z",status:"pending" as const
});

export const STOREKIT_SYNC_RESPONSE_FIXTURE = Object.freeze({
  entitledProductIDs:["whox.treasury.equity.monthly"],reconciledAt:"2026-08-01T14:00:00.000Z"
});
