BEGIN;

CREATE ROLE whox_tenant_test NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT USAGE ON SCHEMA public, app TO whox_tenant_test;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO whox_tenant_test;

INSERT INTO users(id,public_id,email,display_name)
VALUES ('10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','tenant-two@whox.example','Tenant Two');
INSERT INTO user_profiles(user_id,profile)
VALUES ('10000000-0000-4000-8000-000000000002','{"notificationPreferences":{"detailedPreviewsEnabled":true}}');

DO $$
BEGIN
  IF (SELECT account_mode FROM users WHERE id='10000000-0000-4000-8000-000000000002') <> 'demo' THEN
    RAISE EXCEPTION 'safe account_mode default must be demo';
  END IF;
END $$;

INSERT INTO risk_assessments(id,user_id,classification,scoring_version,explanation)
VALUES ('13000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','moderate','test-1','Tenant isolation test');
INSERT INTO risk_assessment_answers(id,assessment_id,question_id,answer) VALUES
('13100000-0000-4000-8000-000000000001','13000000-0000-4000-8000-000000000001','test-answer','"one"'::jsonb),
('13100000-0000-4000-8000-000000000002','13000000-0000-4000-8000-000000000002','test-answer','"two"'::jsonb);

INSERT INTO subscriptions(id,user_id,plan_id,original_transaction_id,status,environment,effective_at) VALUES
('14000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','01000000-0000-4000-8000-000000000001','test-original-two','active','xcode',clock_timestamp());
INSERT INTO subscription_events(id,subscription_id,transaction_id,event_type,signed_payload_digest,event_timestamp,idempotency_key,payload) VALUES
('14100000-0000-4000-8000-000000000001','14000000-0000-4000-8000-000000000001','test-transaction-one','verified','digest-one',clock_timestamp(),'subscription-event-one','{}'),
('14100000-0000-4000-8000-000000000002','14000000-0000-4000-8000-000000000002','test-transaction-two','verified','digest-two',clock_timestamp(),'subscription-event-two','{}');

INSERT INTO broker_connections(id,user_id,provider,status) VALUES
('21000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','robinhood_mcp','connected');
INSERT INTO user_agents(id,user_id,agent_version_id,status,environment,allocation_limit,approval_mode) VALUES
('60000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','31000000-0000-4000-8000-000000000001','paused','demo',0.1,'observe');
INSERT INTO broker_capabilities(id,connection_id,tool_name,input_schema,protocol_version,discovered_at,last_seen_at) VALUES
('21100000-0000-4000-8000-000000000001','21000000-0000-4000-8000-000000000001','test_one','{}','2026-07-28',clock_timestamp(),clock_timestamp()),
('21100000-0000-4000-8000-000000000002','21000000-0000-4000-8000-000000000002','test_two','{}','2026-07-28',clock_timestamp(),clock_timestamp());

INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload,idempotency_key)
VALUES ('99000000-0000-4000-8000-000000000001','user','10000000-0000-4000-8000-000000000001','test','{}','outbox-security-test');

INSERT INTO legal_documents(id,document_key,version,title,content_uri,content_sha256)
VALUES ('12000000-0000-4000-8000-000000000099','security-test','1','Security Test','https://whox.example/legal/security-test','0000000000000000000000000000000000000000000000000000000000000000');
INSERT INTO legal_consents(id,user_id,legal_document_id,accepted_at,user_agent_digest)
VALUES ('12100000-0000-4000-8000-000000000099','10000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000099',clock_timestamp(),'original');

INSERT INTO devices(id,user_id,public_identifier,platform) VALUES
('91000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','91100000-0000-4000-8000-000000000001','ios'),
('91000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','91100000-0000-4000-8000-000000000002','ios');
INSERT INTO sessions(id,user_id,device_id,refresh_token_digest,expires_at) VALUES
('91200000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-000000000001','step-up-session-one',clock_timestamp()+interval '1 hour'),
('91200000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','91000000-0000-4000-8000-000000000002','step-up-session-two',clock_timestamp()+interval '1 hour');
INSERT INTO step_up_authentication_uses(user_id,verification_id,session_id,device_identifier_digest,action,resource_id,authentication_method,authenticated_at,expires_at,used_at) VALUES
('10000000-0000-4000-8000-000000000001','security-step-up-one','91200000-0000-4000-8000-000000000001',repeat('a',64),'resume_all_user_agents','10000000-0000-4000-8000-000000000001','app_attest',clock_timestamp()-interval '10 seconds',clock_timestamp()+interval '5 minutes',clock_timestamp()),
('10000000-0000-4000-8000-000000000002','security-step-up-two','91200000-0000-4000-8000-000000000002',repeat('b',64),'resume_all_user_agents','10000000-0000-4000-8000-000000000002','app_attest',clock_timestamp()-interval '10 seconds',clock_timestamp()+interval '5 minutes',clock_timestamp());

SET LOCAL ROLE whox_tenant_test;
SELECT set_config('app.user_id','10000000-0000-4000-8000-000000000001',true);

DO $$
BEGIN
  IF (SELECT count(*) FROM users) <> 1 THEN RAISE EXCEPTION 'users tenant isolation failed'; END IF;
  IF (SELECT count(*) FROM risk_assessment_answers) <> 1 THEN RAISE EXCEPTION 'risk answer tenant isolation failed'; END IF;
  IF (SELECT count(*) FROM subscription_events) <> 1 THEN RAISE EXCEPTION 'subscription event tenant isolation failed'; END IF;
  IF (SELECT count(*) FROM broker_capabilities) <> 1 THEN RAISE EXCEPTION 'broker capability tenant isolation failed'; END IF;
  IF (SELECT count(*) FROM step_up_authentication_uses) <> 1 THEN RAISE EXCEPTION 'step-up authentication use tenant isolation failed'; END IF;
  IF (SELECT count(*) FROM outbox_events) <> 0 THEN RAISE EXCEPTION 'outbox must be service-only'; END IF;
END $$;

DO $$
BEGIN
  BEGIN
    INSERT INTO risk_assessment_answers(assessment_id,question_id,answer)
    VALUES ('13000000-0000-4000-8000-000000000002','cross-tenant-write','true');
    RAISE EXCEPTION 'cross-tenant answer insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

DO $$
BEGIN
  BEGIN
    UPDATE step_up_authentication_uses SET resource_id='tampered'
    WHERE verification_id='security-step-up-one';
    RAISE EXCEPTION 'immutable step-up authentication use unexpectedly changed';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  BEGIN
    INSERT INTO step_up_authentication_uses(user_id,verification_id,session_id,device_identifier_digest,action,resource_id,authentication_method,authenticated_at,expires_at,used_at)
    VALUES ('10000000-0000-4000-8000-000000000001','security-cross-tenant','91200000-0000-4000-8000-000000000002',repeat('c',64),'delete_account','10000000-0000-4000-8000-000000000001','app_attest',clock_timestamp()-interval '10 seconds',clock_timestamp()+interval '5 minutes',clock_timestamp());
    RAISE EXCEPTION 'cross-tenant step-up session reference unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;

-- RLS on a child row is not sufficient by itself: its parent UUID must also
-- belong to the same tenant. The composite foreign keys in migration 004 make
-- this guessed cross-tenant reference fail at the database boundary.
DO $$
BEGIN
  BEGIN
    INSERT INTO agent_configurations(user_agent_id,user_id,version,configuration,effective_at)
    VALUES (
      '60000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000001',
      1,
      '{"crossTenant":true}',
      clock_timestamp()
    );
    RAISE EXCEPTION 'cross-tenant parent reference unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;

UPDATE legal_consents SET revoked_at=clock_timestamp() WHERE id='12100000-0000-4000-8000-000000000099';
DO $$
BEGIN
  BEGIN
    UPDATE legal_consents SET user_agent_digest='tampered' WHERE id='12100000-0000-4000-8000-000000000099';
    RAISE EXCEPTION 'immutable consent field unexpectedly changed';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END $$;

RESET ROLE;

INSERT INTO notifications(id,user_id,notification_type,priority,title,private_body,status,idempotency_key,scheduled_at)
VALUES ('80000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','security_test','normal','Tenant two','Private','queued','security-notification-two',clock_timestamp());
SET LOCAL ROLE whox_notification_worker;
SELECT set_config('app.user_id','10000000-0000-4000-8000-000000000001',true);
DO $$
BEGIN
  IF (SELECT count(*) FROM user_profiles) <> 1 THEN RAISE EXCEPTION 'notification profile tenant isolation failed'; END IF;
  IF (SELECT count(*) FROM notifications) <> 1 THEN RAISE EXCEPTION 'notification row tenant isolation failed'; END IF;
  IF (SELECT count(*) FROM notifications WHERE user_id='10000000-0000-4000-8000-000000000002') <> 0 THEN RAISE EXCEPTION 'notification cross-tenant read leaked'; END IF;
END $$;
RESET ROLE;

INSERT INTO app_store_server_notifications(
  notification_uuid,environment,notification_type,version,signed_at,signed_payload_digest,
  processing_status,processed_at,normalized_payload
) VALUES (
  '14200000-0000-4000-8000-000000000001','sandbox','TEST','2.0',clock_timestamp(),
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','processed',clock_timestamp(),'{}'
);
INSERT INTO subscriptions(id,user_id,plan_id,original_transaction_id,status,environment,effective_at)
VALUES (
  '14000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000002',
  '01000000-0000-4000-8000-000000000001','storekit-security-original-two','active','sandbox',clock_timestamp()
);
SET LOCAL ROLE whox_app_store_notifications;
SELECT set_config('app.user_id','10000000-0000-4000-8000-000000000001',true);
DO $$
BEGIN
  IF (SELECT count(*) FROM users) <> 1 THEN RAISE EXCEPTION 'App Store role tenant user isolation failed'; END IF;
  IF (SELECT count(*) FROM subscriptions) <> 1 THEN RAISE EXCEPTION 'App Store role tenant subscription isolation failed'; END IF;
  IF (SELECT count(*) FROM app_store_server_notifications WHERE notification_uuid='14200000-0000-4000-8000-000000000001') <> 1 THEN RAISE EXCEPTION 'App Store notification journal access failed'; END IF;
  BEGIN
    PERFORM app.resolve_storekit_notification_tenant(
      'storekit-security-original-two','sandbox','10000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'cross-account original transaction mapping unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM count(*) FROM devices;
    RAISE EXCEPTION 'App Store role unexpectedly read unrelated device data';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;

INSERT INTO queue_jobs(id,queue_name,user_id,job_type,payload,status,idempotency_key)
VALUES ('98000000-0000-4000-8000-000000000001','execution','10000000-0000-4000-8000-000000000001','security_test','{}','queued','security-worker-claim');
SET LOCAL ROLE whox_execution_worker;
DO $$
BEGIN
  IF (SELECT count(*) FROM queue_jobs WHERE id='98000000-0000-4000-8000-000000000001') <> 1 THEN
    RAISE EXCEPTION 'execution worker cannot see durable queue job without tenant GUC';
  END IF;
END $$;
UPDATE queue_jobs SET status='leased',leased_by='security-test',leased_until=clock_timestamp()+interval '30 seconds'
WHERE id='98000000-0000-4000-8000-000000000001';
INSERT INTO reconciliation_jobs(id,order_id,user_id,status,idempotency_key,run_after)
VALUES ('98100000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','queued','security-reconciliation-claim',clock_timestamp());
UPDATE reconciliation_jobs SET status='leased',leased_until=clock_timestamp()+interval '30 seconds'
WHERE id='98100000-0000-4000-8000-000000000001';
SELECT set_config('app.user_id','10000000-0000-4000-8000-000000000001',true);
DO $$
BEGIN
  IF (SELECT count(*) FROM trade_proposals WHERE id='50000000-0000-4000-8000-000000000001') <> 1 THEN
    RAISE EXCEPTION 'execution tenant read failed';
  END IF;
  -- These SELECTs are the complete additional read-only surface used by the
  -- authoritative Paper pre-placement risk recheck. Missing grants must fail
  -- this invariant rather than surfacing only in the production worker.
  PERFORM count(*) FROM legal_documents;
  PERFORM count(*) FROM legal_consents;
  PERFORM count(*) FROM broker_capabilities;
  PERFORM count(*) FROM broker_sync_runs;
  PERFORM count(*) FROM capital_reservations;
  PERFORM count(*) FROM risk_events;
  PERFORM count(*) FROM security_events;
  PERFORM count(*) FROM system_incidents;
END $$;
SELECT set_config('app.user_id','10000000-0000-4000-8000-000000000002',true);
DO $$ BEGIN IF (SELECT count(*) FROM trade_proposals WHERE id='50000000-0000-4000-8000-000000000001') <> 0 THEN RAISE EXCEPTION 'execution cross-tenant read leaked'; END IF; END $$;
RESET ROLE;

ROLLBACK;
