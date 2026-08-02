# Load and backlog tests

This dependency-free Node 22 harness covers the load scenarios required for Metis:

- market-open dashboard, portfolio, positions, proposal, and activity traffic;
- Robinhood connection-status polling;
- privacy-preserving notification bursts with idempotent queue replays;
- thousands of concurrent agent schedules;
- order, proposal, and activity reconciliation polling;
- queue backlog recovery after a transient upstream outage and retry delay.

The default smoke profile is intentionally short enough for CI. It still schedules 2,000 agent runs and checks every result for loss or duplication. The opt-in heavy profile uses 20,000 agent schedules, 5,000 notification deliveries, a 10,000-job recovery backlog, and 2,000 HTTP requests per HTTP scenario.

Run a compiled-repository smoke test:

```sh
npm run build
npm --prefix tests/load run smoke
```

Run the heavier local profile explicitly:

```sh
npm --prefix tests/load run heavy
```

Select one or more scenarios during investigation:

```sh
node tests/load/run.mjs --profile smoke --scenario market-open,connection-polling
```

By default, HTTP scenarios start compiled Demo API instances on ephemeral loopback ports, authenticate with the repository's fixed Demo identity, and close every server afterward. Heavy mode spreads local HTTP traffic over ten embedded instances so the test exercises replica-style aggregate traffic without defeating the API's intentional per-client rate limit.

To exercise an already-running environment, provide an explicit base URL and bearer token:

```sh
LOAD_BASE_URL=https://api.example.test \
LOAD_AUTH_TOKEN=redacted-token \
node tests/load/run.mjs --profile smoke
```

The harness never logs the bearer token and never invents Paper or Live credentials. A configured target receives traffic through its own ingress and rate limits; only run the heavy profile against an environment approved for that volume.

Each scenario emits newline-delimited JSON with counts, throughput, latency percentiles where applicable, and a zero-error assertion. Any non-2xx response, invalid response shape, duplicate execution, lost job, private notification-preview leak, early retry, or stalled backlog fails the process.
