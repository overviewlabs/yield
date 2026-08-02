BEGIN;

INSERT INTO feature_flags(key,enabled,environment,description) VALUES
('LIVE_TRADING_ENABLED',false,'live','Master live order-submission gate'),
('ROBINHOOD_PRODUCTION_APPROVED',false,'live','Formal Robinhood production approval'),
('LEGAL_DOCUMENTS_APPROVED',false,'live','Counsel-approved legal documents published'),
('ADVISORY_COMPLIANCE_APPROVED',false,'live','Advisory and compliance approval'),
('APP_STORE_FINANCIAL_ENTITY_APPROVED',false,'live','App Store financial entity approval'),
('OPTIONS_LIVE_TRADING_ENABLED',false,'live','Options live-submission gate'),
('AUTONOMOUS_MODE_ENABLED',false,'live','Automatic-within-limits gate')
ON CONFLICT (key) DO UPDATE SET enabled=false, updated_at=clock_timestamp();

INSERT INTO plans(id,plan_key,display_name,product_id,features) VALUES
('01000000-0000-4000-8000-000000000001','equity','Equity','whox.treasury.equity.monthly','{"stockTrading":true,"optionsTrading":false,"multiLegOptions":false,"maximumActiveAgents":1,"automaticMode":false,"monitoringFrequencyMinutes":1440,"advancedAnalytics":false,"customWatchlists":false,"scannerAccess":false,"agentCatalog":["foundation-equity"],"prioritySupport":false}'),
('01000000-0000-4000-8000-000000000002','equity_pro','Equity Pro','whox.treasury.equitypro.monthly','{"stockTrading":true,"optionsTrading":false,"multiLegOptions":false,"maximumActiveAgents":3,"automaticMode":true,"monitoringFrequencyMinutes":30,"advancedAnalytics":true,"customWatchlists":true,"scannerAccess":true,"agentCatalog":["foundation-equity","equity-momentum","quality-swing"],"prioritySupport":true}'),
('01000000-0000-4000-8000-000000000003','options','Options','whox.treasury.options.monthly','{"stockTrading":true,"optionsTrading":true,"multiLegOptions":false,"maximumActiveAgents":3,"automaticMode":true,"monitoringFrequencyMinutes":30,"advancedAnalytics":true,"customWatchlists":true,"scannerAccess":true,"agentCatalog":["foundation-equity","directional-options","covered-strategy"],"prioritySupport":true}'),
('01000000-0000-4000-8000-000000000004','options_pro','Options Pro','whox.treasury.optionspro.monthly','{"stockTrading":true,"optionsTrading":true,"multiLegOptions":true,"maximumActiveAgents":3,"automaticMode":true,"monitoringFrequencyMinutes":15,"advancedAnalytics":true,"customWatchlists":true,"scannerAccess":true,"agentCatalog":["foundation-equity","defined-risk-spreads","range-volatility"],"prioritySupport":true}')
ON CONFLICT (plan_key) DO UPDATE SET display_name=EXCLUDED.display_name,product_id=EXCLUDED.product_id,features=EXCLUDED.features;

INSERT INTO agent_definitions(id,agent_key,display_name,strategy_category) VALUES
('30000000-0000-4000-8000-000000000001','foundation-equity','Foundation Equity','diversified_long_only'),
('30000000-0000-4000-8000-000000000002','equity-momentum','Equity Momentum','momentum_long_only'),
('30000000-0000-4000-8000-000000000003','quality-swing','Quality Swing','quality_technical_swing'),
('30000000-0000-4000-8000-000000000004','directional-options','Directional Options','long_premium_directional'),
('30000000-0000-4000-8000-000000000005','covered-strategy','Covered Strategy','covered_calls_protective_puts'),
('30000000-0000-4000-8000-000000000006','defined-risk-spreads','Defined-Risk Spreads','defined_risk_multileg'),
('30000000-0000-4000-8000-000000000007','range-volatility','Range and Volatility','limited_risk_range')
ON CONFLICT (agent_key) DO NOTHING;

INSERT INTO agent_versions(id,agent_definition_id,version,required_plan_key,definition,deterministic_strategy_version,status) VALUES
('31000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','1.0.0','equity','{"permittedAccountModes":["demo","paper"],"instruments":["equity"],"restrictions":["long_only","no_margin","no_penny_stocks"]}','foundation-equity-rules-1.0.0','paper'),
('31000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000002','1.0.0','equity_pro','{"permittedAccountModes":["demo","paper"],"instruments":["equity"],"restrictions":["long_only","no_short_selling","no_averaging_down"]}','equity-momentum-rules-1.0.0','paper'),
('31000000-0000-4000-8000-000000000003','30000000-0000-4000-8000-000000000003','1.0.0','equity_pro','{"permittedAccountModes":["demo","paper"],"instruments":["equity"],"restrictions":["long_only","earnings_policy"]}','quality-swing-rules-1.0.0','paper'),
('31000000-0000-4000-8000-000000000004','30000000-0000-4000-8000-000000000004','1.0.0','options','{"permittedAccountModes":["demo","paper"],"instruments":["option"],"restrictions":["long_premium","no_0dte","limit_orders"]}','directional-options-rules-1.0.0','paper'),
('31000000-0000-4000-8000-000000000005','30000000-0000-4000-8000-000000000005','1.0.0','options','{"permittedAccountModes":["demo","paper"],"instruments":["option"],"restrictions":["no_uncovered_calls","coverage_required"]}','covered-strategy-rules-1.0.0','paper'),
('31000000-0000-4000-8000-000000000006','30000000-0000-4000-8000-000000000006','1.0.0','options_pro','{"permittedAccountModes":["demo","paper"],"instruments":["option"],"restrictions":["defined_maximum_loss","no_naked_options"]}','defined-risk-spreads-rules-1.0.0','paper'),
('31000000-0000-4000-8000-000000000007','30000000-0000-4000-8000-000000000007','1.0.0','options_pro','{"permittedAccountModes":["demo","paper"],"instruments":["option"],"restrictions":["compliance_approval_required","defined_risk"]}','range-volatility-rules-1.0.0','draft')
ON CONFLICT (agent_definition_id,version) DO NOTHING;

INSERT INTO legal_documents(id,document_key,version,title,content_uri,content_sha256,production_approved) VALUES
('02000000-0000-4000-8000-000000000001','terms','demo-1','Demo Terms Fixture','fixture://legal/terms','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',false),
('02000000-0000-4000-8000-000000000002','privacy','demo-1','Demo Privacy Fixture','fixture://legal/privacy','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',false),
('02000000-0000-4000-8000-000000000003','ai-risk','demo-1','Demo AI Agent Risk Fixture','fixture://legal/ai-risk','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',false),
('02000000-0000-4000-8000-000000000004','options-risk','demo-1','Demo Options Risk Fixture','fixture://legal/options-risk','dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',false)
ON CONFLICT (document_key,version) DO NOTHING;

INSERT INTO users(id,public_id,status,email,display_name,jurisdiction_country,jurisdiction_region,account_mode,onboarding_step) VALUES
('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','active','review@whox.example','Treasury Reviewer','US','NY','demo',14)
ON CONFLICT (id) DO NOTHING;
INSERT INTO user_identities(id,user_id,provider,provider_subject,last_authenticated_at) VALUES
('11000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','apple','demo.apple.subject','2026-08-01T14:00:00Z') ON CONFLICT DO NOTHING;
INSERT INTO user_profiles(user_id,profile) VALUES ('10000000-0000-4000-8000-000000000001','{"objective":"growth","holdingPeriod":"multi_year","demo":true}') ON CONFLICT (user_id) DO NOTHING;
INSERT INTO eligibility_profiles(id,user_id,country,region,age_eligible,own_individual_account,eligibility_status,assessment_version,assessed_at) VALUES
('12000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','US','NY',true,true,'eligible','demo-1','2026-08-01T14:00:00Z') ON CONFLICT DO NOTHING;
INSERT INTO risk_assessments(id,user_id,classification,scoring_version,explanation,completed_at) VALUES
('13000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','moderate','demo-1','Demo fixture classification; not brokerage options approval.','2026-08-01T14:00:00Z') ON CONFLICT DO NOTHING;
INSERT INTO subscriptions(id,user_id,plan_id,original_transaction_id,status,environment,effective_at) VALUES
('14000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','01000000-0000-4000-8000-000000000001','demo-original-transaction','active','xcode','2026-08-01T14:00:00Z') ON CONFLICT DO NOTHING;

INSERT INTO broker_connections(id,user_id,provider,status,connected_at,last_sync_at) VALUES
('21000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','robinhood_mcp','connected','2026-08-01T14:00:00Z','2026-08-01T14:00:00Z') ON CONFLICT DO NOTHING;
INSERT INTO broker_accounts(id,connection_id,user_id,opaque_broker_id,masked_identifier,account_type,is_agentic_account,verified_for_trading_at,active) VALUES
('20000000-0000-4000-8000-000000000001','21000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','demo-agentic-account','Demo Agentic account •••• 2841','demo_individual_agentic',true,NULL,true) ON CONFLICT DO NOTHING;
INSERT INTO portfolio_snapshots(id,user_id,broker_account_id,environment,total_value,buying_power,cash_value,source_timestamp,valid_until,data_classification) VALUES
('22000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','demo',12430,5230,5230,'2026-08-01T14:00:00Z','infinity','demo') ON CONFLICT DO NOTHING;
INSERT INTO position_snapshots(id,portfolio_snapshot_id,user_id,broker_position_id,symbol,instrument_type,quantity,average_cost,market_value,unrealized_pnl,details) VALUES
('23000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','demo-aapl','AAPL','equity',5,184,1000,80,'{"dataClassification":"demo"}'),
('23000000-0000-4000-8000-000000000002','22000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','demo-spy-put','SPY','option',1,2.50,240,-10,'{"strategy":"protective_put","expiration":"2026-09-18","maximumLoss":250,"dataClassification":"demo"}')
ON CONFLICT DO NOTHING;

INSERT INTO user_agents(id,user_id,agent_version_id,status,environment,allocation_limit,approval_mode) VALUES
('60000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000001','monitoring','demo',0.4,'confirm_every_trade') ON CONFLICT DO NOTHING;
INSERT INTO risk_policies(id,user_id,version,limits,effective_at) VALUES
('40000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',1,'{"maximumAccountAllocation":0.6,"maximumPositionAmount":5000,"maximumNewOrderAmount":2000,"maximumDailyLoss":500,"maximumPortfolioDrawdown":0.1,"minimumBuyingPowerReserve":0.2,"maximumSimultaneousPositions":10}','2026-08-01T14:00:00Z') ON CONFLICT DO NOTHING;
INSERT INTO agent_runs(id,user_id,user_agent_id,status,idempotency_key,started_at,completed_at,strategy_version,structured_outcome) VALUES
('51000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001','completed','demo-agent-run-1','2026-08-01T13:59:00Z','2026-08-01T14:00:00Z','foundation-equity-rules-1.0.0','{"outcome":"proposal_created","dataClassification":"demo"}') ON CONFLICT DO NOTHING;
INSERT INTO trade_proposals(id,user_id,broker_account_id,agent_run_id,agent_version_id,environment,status,version,symbol,instrument_type,proposal,proposal_fingerprint,idempotency_key,expires_at,created_at,updated_at) VALUES
('50000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','51000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000001','demo','FILLED',10,'AAPL','equity','{"proposalId":"50000000-0000-4000-8000-000000000001","userId":"10000000-0000-4000-8000-000000000001","accountId":"20000000-0000-4000-8000-000000000001","agentDefinitionId":"30000000-0000-4000-8000-000000000001","agentVersion":"1.0.0","environment":"demo","instrumentType":"equity","symbol":"AAPL","optionLegs":[],"side":"buy","quantity":5,"notionalEstimate":1000,"orderType":"limit","limitPrice":200,"timeInForce":"day","strategyType":"foundation_equity","entryReason":"Demo fixture entry","exitPlan":"Demo deterministic exit","invalidationCondition":"Demo thesis invalidated","dataTimestamp":"2026-08-01T14:00:00Z","quoteTimestamp":"2026-08-01T14:00:00Z","maximumLoss":1000,"breakevens":[],"estimatedPortfolioAllocationAfter":0.2,"riskAmount":1000,"confidenceCategoryWithoutProbabilityClaims":"moderate","requiredApprovalMode":"confirm_every_trade","expirationTimestamp":"2026-08-01T14:05:00Z","evidenceReferences":[],"warnings":[],"deterministicStrategyVersion":"foundation-equity-rules-1.0.0","dataClassification":"demo"}','eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee','demo-proposal-1','2026-08-01T14:05:00Z','2026-08-01T14:00:00Z','2026-08-01T14:00:01Z') ON CONFLICT DO NOTHING;
INSERT INTO risk_checks(id,proposal_id,user_id,policy_id,check_code,passed,severity,evaluated_at) VALUES
('52000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','DEMO_FIXTURE_CHECK',true,'info','2026-08-01T14:00:00Z') ON CONFLICT DO NOTHING;
INSERT INTO orders(id,user_id,proposal_id,broker_account_id,broker_order_id,instrument_type,status,submission_idempotency_key,submitted_at,terminal_at) VALUES
('70000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','demo-order-filled-1','equity','filled','demo-order-submit-1','2026-08-01T14:00:00Z','2026-08-01T14:00:01Z') ON CONFLICT DO NOTHING;
INSERT INTO fills(id,order_id,user_id,broker_fill_id,quantity,price,fees,occurred_at) VALUES
('71000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','demo-fill-1',5,199.96,0,'2026-08-01T14:00:01Z') ON CONFLICT DO NOTHING;
INSERT INTO risk_events(id,user_id,broker_account_id,proposal_id,environment,event_type,severity,reason_code,structured_details,occurred_at) VALUES
('72000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001','demo','daily_loss_warning','warning','DEMO_THRESHOLD_APPROACHING','{"dataClassification":"demo"}','2026-08-01T14:00:00Z') ON CONFLICT DO NOTHING;
INSERT INTO notifications(id,user_id,notification_type,priority,title,private_body,status,idempotency_key,scheduled_at) VALUES
('80000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','proposal_ready','normal','Demo proposal ready','Open WHOX Treasury to review.','queued','demo-notification-1','2026-08-01T14:00:00Z') ON CONFLICT DO NOTHING;
INSERT INTO demo_sessions(id,user_id,review_identifier,started_at,expires_at) VALUES
('90000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','app-review','2026-08-01T14:00:00Z','2030-08-01T14:00:00Z') ON CONFLICT DO NOTHING;

COMMIT;
