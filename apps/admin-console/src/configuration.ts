export type AdminConfigurationStatus = "demo-ready" | "mock-outside-demo" | "oidc-unconfigured";

export function adminConfigurationStatus(
  deployment: "demo" | "paper" | "live",
  authMode: "mock" | "oidc",
): AdminConfigurationStatus {
  if (authMode === "oidc") return "oidc-unconfigured";
  return deployment === "demo" ? "demo-ready" : "mock-outside-demo";
}
