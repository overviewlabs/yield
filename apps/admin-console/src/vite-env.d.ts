/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEPLOYMENT_ENV?: "demo" | "paper" | "live";
  readonly VITE_ADMIN_AUTH_MODE?: "mock" | "oidc";
}

interface ImportMeta { readonly env: ImportMetaEnv }
