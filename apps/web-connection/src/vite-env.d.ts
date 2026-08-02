/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEPLOYMENT_ENV?: "demo" | "paper" | "live";
  readonly VITE_PAIRING_PROVIDER?: "mock" | "api";
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_ALLOWED_AUTH_ORIGINS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
