import { readFileSync } from "node:fs";
import { DomainError } from "@whox/contracts";

const maximumCredentialBytes = 64 * 1024;

/**
 * Resolve a runtime value from either NAME or NAME_FILE. File-backed values are
 * suitable for systemd credentials, Docker secrets, and managed-secret mounts.
 * Requiring exactly one source prevents a stale inline value from silently
 * overriding a rotated credential.
 */
export function environmentValue(
  environment: NodeJS.ProcessEnv,
  name: string
): string | undefined {
  const inline = environment[name];
  const filePath = environment[`${name}_FILE`]?.trim();
  if (inline !== undefined && filePath !== undefined && filePath !== "") {
    throw new DomainError(
      "RUNTIME_VALUE_SOURCE_AMBIGUOUS",
      `${name} and ${name}_FILE cannot both be configured`,
      500
    );
  }
  if (filePath === undefined || filePath === "") return inline?.trim();
  try {
    const value = readFileSync(filePath);
    if (value.byteLength > maximumCredentialBytes) {
      throw new DomainError(
        "RUNTIME_VALUE_FILE_TOO_LARGE",
        `${name}_FILE exceeds the maximum credential size`,
        500
      );
    }
    return value.toString("utf8").trim();
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      "RUNTIME_VALUE_FILE_UNAVAILABLE",
      `${name}_FILE could not be read`,
      500
    );
  }
}
