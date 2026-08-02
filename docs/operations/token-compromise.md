# Token-compromise runbook

Use [`infrastructure/runbooks/token-compromise.md`](../../infrastructure/runbooks/token-compromise.md).

Pause affected scope, revoke broker authorization, isolate refresh/KMS/IAM paths, rotate without printing the token, investigate by token fingerprint/metadata, reconcile broker activity, follow approved notices, and require fresh authorization before recovery. A compromised external-agent key additionally requires orchestrator shutdown, provider-side revocation, Hermes VPS tool/session review, and a new secret delivered directly through the managed secret system. If scope is unknown, engage the global kill switch. Never “test” a suspect token in a shell or support tool.
