import { describe, expect, it } from "vitest";
import { adminConfigurationStatus } from "./configuration";

describe("administrator runtime configuration", () => {
  it("permits simulated administration only in Demo", () => {
    expect(adminConfigurationStatus("demo", "mock")).toBe("demo-ready");
    expect(adminConfigurationStatus("paper", "mock")).toBe("mock-outside-demo");
  });

  it("fails closed while OIDC and API-backed roles are unconfigured", () => {
    expect(adminConfigurationStatus("demo", "oidc")).toBe("oidc-unconfigured");
    expect(adminConfigurationStatus("live", "oidc")).toBe("oidc-unconfigured");
  });
});
