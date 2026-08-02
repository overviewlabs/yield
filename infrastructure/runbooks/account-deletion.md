# Account deletion

1. Authenticate the user strongly and create an idempotent deletion request. Show that deletion does not close brokerage positions or the Robinhood account.
2. Pause future evaluations/submissions and reconcile all open orders. If orders or positions exist, explain what remains at the broker and provide safe disconnect steps.
3. Revoke WHOX sessions, device tokens, broker authorization, and non-required secrets. Stop nonessential processing.
4. Generate the user export when requested and legally allowed. Verify delivery through the approved secure channel.
5. Delete or anonymize data eligible for deletion; place records subject to regulatory, tax, fraud, dispute, or litigation retention into access-restricted retention partitions.
6. Preserve an immutable minimal audit record containing request identity reference, timestamps, legal basis, data classes retained/deleted, and completing actor. Do not claim retained records were erased.
7. Notify the user of completion, retained categories and periods approved by counsel, and how to contact support. Verify caches, search indexes, analytics, and subprocessors receive the deletion instruction.
