import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { environmentValue } from "../src/environment-value.js";

describe("environmentValue", () => {
  it("loads and trims a mounted credential", () => {
    const directory = mkdtempSync(join(tmpdir(), "yield-credential-"));
    const path = join(directory, "session-signing-secret");
    try {
      writeFileSync(path, "  mounted-secret-value  \n", { mode: 0o600 });
      assert.equal(
        environmentValue({ SESSION_SIGNING_SECRET_FILE: path }, "SESSION_SIGNING_SECRET"),
        "mounted-secret-value"
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects ambiguous inline and file-backed sources", () => {
    assert.throws(
      () => environmentValue({ TOKEN: "inline", TOKEN_FILE: "/run/credentials/token" }, "TOKEN"),
      (error: unknown) =>
        typeof error === "object" && error !== null
          && "code" in error && error.code === "RUNTIME_VALUE_SOURCE_AMBIGUOUS"
    );
  });

  it("does not disclose an unavailable credential path through its error", () => {
    assert.throws(
      () => environmentValue({ TOKEN_FILE: "/private/not-present" }, "TOKEN"),
      (error: unknown) =>
        error instanceof Error
          && error.message === "TOKEN_FILE could not be read"
          && !error.message.includes("/private/not-present")
    );
  });
});
