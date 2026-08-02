import { readFile, readdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import process from "node:process";

const repositoryRoot = resolve(import.meta.dirname, "..");
const requiredLockedGates = [
  "LIVE_TRADING_ENABLED",
  "ROBINHOOD_PRODUCTION_APPROVED",
  "LEGAL_DOCUMENTS_APPROVED",
  "ADVISORY_COMPLIANCE_APPROVED",
  "APP_STORE_FINANCIAL_ENTITY_APPROVED",
  "OPTIONS_LIVE_TRADING_ENABLED",
  "AUTONOMOUS_MODE_ENABLED",
];

function fail(message) {
  process.stderr.write(`Safety verification failed: ${message}\n`);
  process.exitCode = 1;
}

const exampleEnvironment = await readFile(join(repositoryRoot, ".env.example"), "utf8");
const environment = Object.fromEntries(
  exampleEnvironment
    .split(/\r?\n/u)
    .filter((line) => line.length > 0 && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);

for (const gate of requiredLockedGates) {
  if (environment[gate] !== "false") fail(`.env.example must set ${gate}=false`);
}

if (environment.APP_ENV !== "demo") fail(".env.example must default APP_ENV to demo");
if (environment.ROBINHOOD_MCP_URL !== "https://agent.robinhood.com/mcp/trading") {
  fail("ROBINHOOD_MCP_URL must be the documented Trading MCP endpoint");
}
if (environment.HERMES_BASE_URL !== "https://treasury-bot.whox.ai/v1") {
  fail("HERMES_BASE_URL must be the reviewed research endpoint");
}
if (environment.HERMES_MODEL !== "treasury-bot") {
  fail("HERMES_MODEL must be the reviewed research model");
}
if (environment.HERMES_API_KEY !== "") {
  fail(".env.example must never contain a Hermes API key");
}
if (environment.HERMES_RESEARCH_PROFILE_TOOLS_DISABLED !== "false") {
  fail("the sample environment must fail closed until the remote tool-free Hermes profile is verified");
}

const scannedRoots = ["apps", "services", "packages", "database", "infrastructure"];
const sourceExtensions = new Set([
  ".cjs", ".env", ".js", ".json", ".mjs", ".sql", ".swift", ".tf", ".ts", ".tsx", ".yaml", ".yml",
]);
const skippedNames = new Set([".build", ".git", ".swiftpm", "coverage", "DerivedData", "dist", "node_modules"]);
const prohibitedIntegrationPatterns = [
  /https?:\/\/api\.robinhood\.com/iu,
  /robinhood[_-]?(?:password|username)\s*[:=]/iu,
  /place_(?:equity|option)_order\([^)]*model/iu,
];
const releaseGateFiles = [];

async function scanDirectory(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }

  for (const entry of entries) {
    if (skippedNames.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await scanDirectory(path);
      continue;
    }
    if (!entry.isFile() || !sourceExtensions.has(extname(entry.name))) continue;
    const contents = await readFile(path, "utf8");
    const relativePath = path.slice(repositoryRoot.length + 1);
    if (entry.name === "ReleaseGates.json") releaseGateFiles.push({ path, contents });
    if (
      relativePath.startsWith("services/") &&
      !relativePath.startsWith("services/agent-orchestrator/") &&
      /\bHERMES_[A-Z0-9_]+\b|treasury-bot\.whox\.ai/iu.test(contents)
    ) {
      fail(`${relativePath} crosses the model boundary; Hermes configuration belongs only to agent-orchestrator`);
    }
    if (
      relativePath.startsWith("services/agent-orchestrator/") &&
      /BROKER_TOKEN_SECRET_ARN|broker-token-vault/iu.test(contents)
    ) {
      fail(`${relativePath} crosses the credential boundary; agent-orchestrator cannot access the broker token vault`);
    }
    for (const pattern of prohibitedIntegrationPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(contents)) {
        fail(`${relativePath} contains prohibited broker integration pattern ${pattern}`);
      }
    }
  }
}

await Promise.all(scannedRoots.map((directory) => scanDirectory(join(repositoryRoot, directory))));

for (const { path, contents } of releaseGateFiles) {
  let gates;
  try {
    gates = JSON.parse(contents);
  } catch {
    fail(`${path.slice(repositoryRoot.length + 1)} is not valid JSON`);
    continue;
  }
  for (const gate of requiredLockedGates) {
    if (gates[gate] !== false) {
      fail(`${path.slice(repositoryRoot.length + 1)} must set ${gate} to false`);
    }
  }
}

if (process.exitCode !== 1) {
  process.stdout.write("Safety verification passed: Demo default, all release gates locked, official MCP boundary only.\n");
}
