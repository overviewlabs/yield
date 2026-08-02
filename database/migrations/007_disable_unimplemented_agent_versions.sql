BEGIN;

-- Only Foundation Equity v1 currently has a persistent deterministic runtime
-- pipeline. Keep all other specifications visible in the catalog but prevent
-- Paper activation until their runtime, validation, and regression suite ship.
UPDATE agent_versions
SET status='draft'
WHERE id IN (
  '31000000-0000-4000-8000-000000000002',
  '31000000-0000-4000-8000-000000000003',
  '31000000-0000-4000-8000-000000000004',
  '31000000-0000-4000-8000-000000000005',
  '31000000-0000-4000-8000-000000000006',
  '31000000-0000-4000-8000-000000000007'
);

COMMIT;
