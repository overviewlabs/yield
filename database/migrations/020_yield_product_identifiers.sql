BEGIN;

-- Product identifiers are immutable App Store identities. Existing databases
-- predate the Yield bundle migration, so ON CONFLICT catalog seeds cannot
-- correct them after first insertion.
UPDATE plans
SET product_id = CASE plan_key
  WHEN 'equity' THEN 'ai.whox.yield.equity.monthly'
  WHEN 'equity_pro' THEN 'ai.whox.yield.equitypro.monthly'
  WHEN 'options' THEN 'ai.whox.yield.options.monthly'
  WHEN 'options_pro' THEN 'ai.whox.yield.optionspro.monthly'
  ELSE product_id
END
WHERE plan_key IN ('equity','equity_pro','options','options_pro');

DO $$
BEGIN
  IF (
    SELECT count(*)
    FROM plans
    WHERE (plan_key,product_id) IN (
      ('equity','ai.whox.yield.equity.monthly'),
      ('equity_pro','ai.whox.yield.equitypro.monthly'),
      ('options','ai.whox.yield.options.monthly'),
      ('options_pro','ai.whox.yield.optionspro.monthly')
    )
  ) <> 4 THEN
    RAISE EXCEPTION 'Yield App Store product catalog migration is incomplete';
  END IF;
END $$;

COMMIT;
