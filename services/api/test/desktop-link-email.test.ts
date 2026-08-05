import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { desktopAuthorizationHandoffUrl, validatedRobinhoodEmail } from "../src/desktop-link-email.js";

describe("desktop link email safety", () => {
  it("keeps the private Robinhood authorization URL in a browser fragment", () => {
    const authorization = new URL("https://robinhood.com/oauth?state=opaque&code_challenge=safe");
    const handoff = desktopAuthorizationHandoffUrl(new URL("https://connect.whox.ai/desktop"), authorization);
    assert.equal(handoff.origin, "https://connect.whox.ai");
    assert.equal(handoff.pathname, "/desktop");
    assert.equal(handoff.search, "");
    assert.equal(new URLSearchParams(handoff.hash.slice(1)).get("authorization"), authorization.href);
  });

  it("normalizes email without accepting header injection", () => {
    assert.equal(validatedRobinhoodEmail(" Person@Example.com "), "person@example.com");
    assert.throws(() => validatedRobinhoodEmail("person@example.com\nBcc: attacker@example.com"));
  });
});
