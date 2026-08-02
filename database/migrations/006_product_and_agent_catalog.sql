BEGIN;

-- Production-safe catalog rows belong in migrations. The nonproduction seed
-- file may add Demo users and fixtures, but Paper must not depend on loading it.
INSERT INTO plans(id,plan_key,display_name,product_id,features) VALUES
('01000000-0000-4000-8000-000000000001','equity','Equity','ai.whox.metis.equity.monthly','{"stockTrading":true,"optionsTrading":false,"multiLegOptions":false,"maximumActiveAgents":1,"automaticMode":false,"monitoringFrequencyMinutes":1440,"advancedAnalytics":false,"customWatchlists":false,"scannerAccess":false,"agentCatalog":["foundation-equity"],"prioritySupport":false}'),
('01000000-0000-4000-8000-000000000002','equity_pro','Equity Pro','ai.whox.metis.equitypro.monthly','{"stockTrading":true,"optionsTrading":false,"multiLegOptions":false,"maximumActiveAgents":3,"automaticMode":true,"monitoringFrequencyMinutes":30,"advancedAnalytics":true,"customWatchlists":true,"scannerAccess":true,"agentCatalog":["foundation-equity","equity-momentum","quality-swing"],"prioritySupport":true}'),
('01000000-0000-4000-8000-000000000003','options','Options','ai.whox.metis.options.monthly','{"stockTrading":true,"optionsTrading":true,"multiLegOptions":false,"maximumActiveAgents":3,"automaticMode":true,"monitoringFrequencyMinutes":30,"advancedAnalytics":true,"customWatchlists":true,"scannerAccess":true,"agentCatalog":["foundation-equity","equity-momentum","quality-swing","directional-options","covered-strategy"],"prioritySupport":true}'),
('01000000-0000-4000-8000-000000000004','options_pro','Options Pro','ai.whox.metis.optionspro.monthly','{"stockTrading":true,"optionsTrading":true,"multiLegOptions":true,"maximumActiveAgents":5,"automaticMode":true,"monitoringFrequencyMinutes":15,"advancedAnalytics":true,"customWatchlists":true,"scannerAccess":true,"agentCatalog":["foundation-equity","equity-momentum","quality-swing","directional-options","covered-strategy","defined-risk-spreads","range-volatility"],"prioritySupport":true}')
ON CONFLICT (plan_key) DO UPDATE SET display_name=EXCLUDED.display_name,product_id=EXCLUDED.product_id,features=EXCLUDED.features,active=true;

INSERT INTO agent_definitions(id,agent_key,display_name,strategy_category) VALUES
('30000000-0000-4000-8000-000000000001','foundation-equity','Foundation Equity','diversified_long_only'),
('30000000-0000-4000-8000-000000000002','equity-momentum','Equity Momentum','momentum_long_only'),
('30000000-0000-4000-8000-000000000003','quality-swing','Quality Swing','quality_technical_swing'),
('30000000-0000-4000-8000-000000000004','directional-options','Directional Options','long_premium_directional'),
('30000000-0000-4000-8000-000000000005','covered-strategy','Covered Strategy','covered_calls_protective_puts'),
('30000000-0000-4000-8000-000000000006','defined-risk-spreads','Defined-Risk Spreads','defined_risk_multileg'),
('30000000-0000-4000-8000-000000000007','range-volatility','Range and Volatility','limited_risk_range')
ON CONFLICT (agent_key) DO UPDATE SET display_name=EXCLUDED.display_name,strategy_category=EXCLUDED.strategy_category;

INSERT INTO agent_versions(id,agent_definition_id,version,required_plan_key,definition,deterministic_strategy_version,status) VALUES
('31000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','1.0.0','equity','{"permittedAccountModes":["demo","paper"],"instruments":["equity"],"requiredBrokerageCapabilities":["get_equity_quotes","get_equity_tradability","review_equity_order"],"restrictions":["long_only","no_margin","no_penny_stocks"]}','foundation-equity-rules-1.0.0','paper'),
('31000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000002','1.0.0','equity_pro','{"permittedAccountModes":["demo","paper"],"instruments":["equity"],"restrictions":["long_only","no_short_selling","no_averaging_down"]}','equity-momentum-rules-1.0.0','paper'),
('31000000-0000-4000-8000-000000000003','30000000-0000-4000-8000-000000000003','1.0.0','equity_pro','{"permittedAccountModes":["demo","paper"],"instruments":["equity"],"restrictions":["long_only","earnings_policy"]}','quality-swing-rules-1.0.0','paper'),
('31000000-0000-4000-8000-000000000004','30000000-0000-4000-8000-000000000004','1.0.0','options','{"permittedAccountModes":["demo","paper"],"instruments":["option"],"restrictions":["long_premium","no_0dte","limit_orders"]}','directional-options-rules-1.0.0','paper'),
('31000000-0000-4000-8000-000000000005','30000000-0000-4000-8000-000000000005','1.0.0','options','{"permittedAccountModes":["demo","paper"],"instruments":["option"],"restrictions":["no_uncovered_calls","coverage_required"]}','covered-strategy-rules-1.0.0','paper'),
('31000000-0000-4000-8000-000000000006','30000000-0000-4000-8000-000000000006','1.0.0','options_pro','{"permittedAccountModes":["demo","paper"],"instruments":["option"],"restrictions":["defined_maximum_loss","no_naked_options"]}','defined-risk-spreads-rules-1.0.0','paper'),
('31000000-0000-4000-8000-000000000007','30000000-0000-4000-8000-000000000007','1.0.0','options_pro','{"permittedAccountModes":["demo","paper"],"instruments":["option"],"restrictions":["compliance_approval_required","defined_risk"]}','range-volatility-rules-1.0.0','draft')
ON CONFLICT (agent_definition_id,version) DO UPDATE SET required_plan_key=EXCLUDED.required_plan_key,definition=EXCLUDED.definition,deterministic_strategy_version=EXCLUDED.deterministic_strategy_version,status=EXCLUDED.status;

COMMIT;
