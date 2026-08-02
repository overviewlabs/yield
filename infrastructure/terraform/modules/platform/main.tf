locals {
  prefix = "${var.name}-${var.environment}"
  tags = merge(var.tags, {
    Application = var.name
    Environment = var.environment
    ManagedBy   = "terraform"
    DataClass   = "confidential-financial"
  })
  service_names = toset([
    "api",
    "agent-orchestrator",
    "execution-worker",
    "notification-worker",
    "market-data-service",
    "broker-sync-service",
  ])
  release_flags = [
    { name = "LIVE_TRADING_ENABLED", value = "false" },
    { name = "ROBINHOOD_PRODUCTION_APPROVED", value = "false" },
    { name = "LEGAL_DOCUMENTS_APPROVED", value = "false" },
    { name = "ADVISORY_COMPLIANCE_APPROVED", value = "false" },
    { name = "APP_STORE_FINANCIAL_ENTITY_APPROVED", value = "false" },
    { name = "OPTIONS_LIVE_TRADING_ENABLED", value = "false" },
    { name = "AUTONOMOUS_MODE_ENABLED", value = "false" },
  ]
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

data "aws_iam_policy_document" "platform_kms" {
  statement {
    sid       = "EnableAccountAdministration"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  # CloudWatch Logs calls KMS directly rather than through the ECS task role.
  # Bind use of this key to this environment's log-group namespace.
  statement {
    sid = "AllowCloudWatchLogsEncryption"
    actions = [
      "kms:Decrypt*",
      "kms:Describe*",
      "kms:Encrypt*",
      "kms:GenerateDataKey*",
      "kms:ReEncrypt*",
    ]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["logs.${data.aws_region.current.region}.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values = [
        "arn:${data.aws_partition.current.partition}:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:log-group:/whox/${var.environment}/*"
      ]
    }
  }
}

resource "aws_kms_key" "platform" {
  description             = "${local.prefix} envelope encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.platform_kms.json
  tags                    = local.tags
}

resource "aws_kms_alias" "platform" {
  name          = "alias/${local.prefix}"
  target_key_id = aws_kms_key.platform.key_id
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true
  tags                 = merge(local.tags, { Name = "${local.prefix}-vpc" })
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = merge(local.tags, { Name = "${local.prefix}-igw" })
}

resource "aws_subnet" "public" {
  for_each                = toset(var.availability_zones)
  vpc_id                  = aws_vpc.main.id
  availability_zone       = each.value
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, index(var.availability_zones, each.value))
  map_public_ip_on_launch = false
  tags                    = merge(local.tags, { Name = "${local.prefix}-public-${each.value}", Tier = "public" })
}

resource "aws_subnet" "private" {
  for_each          = toset(var.availability_zones)
  vpc_id            = aws_vpc.main.id
  availability_zone = each.value
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, index(var.availability_zones, each.value) + 8)
  tags              = merge(local.tags, { Name = "${local.prefix}-private-${each.value}", Tier = "private" })
}

resource "aws_eip" "nat" {
  for_each = aws_subnet.public
  domain   = "vpc"
  tags     = local.tags
}

resource "aws_nat_gateway" "main" {
  for_each      = aws_subnet.public
  allocation_id = aws_eip.nat[each.key].id
  subnet_id     = each.value.id
  depends_on    = [aws_internet_gateway.main]
  tags          = merge(local.tags, { Name = "${local.prefix}-nat-${each.key}" })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = local.tags
}

resource "aws_route_table_association" "public" {
  for_each       = aws_subnet.public
  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  for_each = aws_subnet.private
  vpc_id   = aws_vpc.main.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main[each.key].id
  }
  tags = local.tags
}

resource "aws_route_table_association" "private" {
  for_each       = aws_subnet.private
  subnet_id      = each.value.id
  route_table_id = aws_route_table.private[each.key].id
}

resource "aws_security_group" "alb" {
  name        = "${local.prefix}-alb"
  description = "Public TLS entry point"
  vpc_id      = aws_vpc.main.id
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 8080
    to_port     = 8080
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }
  tags = local.tags
}

# Runtime OAuth, broker, market-data, and AWS control-plane endpoints do not
# publish stable CIDRs. Egress is NAT-mediated and limited to TCP 443; database,
# Redis, and DNS have separate VPC-only rules. Re-evaluate this exception annually.
#trivy:ignore:AVD-AWS-0104:exp:2027-08-01
resource "aws_security_group" "service" {
  name        = "${local.prefix}-services"
  description = "Private application services"
  vpc_id      = aws_vpc.main.id
  ingress {
    from_port       = 8080
    to_port         = 8080
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  egress {
    description = "HTTPS through the NAT gateway to AWS APIs and approved external providers"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    description = "PostgreSQL inside the environment VPC"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }
  egress {
    description = "Redis inside the environment VPC"
    from_port   = 6379
    to_port     = 6379
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }
  egress {
    description = "VPC DNS over UDP"
    from_port   = 53
    to_port     = 53
    protocol    = "udp"
    cidr_blocks = [var.vpc_cidr]
  }
  egress {
    description = "VPC DNS over TCP"
    from_port   = 53
    to_port     = 53
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }
  tags = local.tags
}

resource "aws_security_group" "data" {
  name        = "${local.prefix}-data"
  description = "Database and Redis from application services only"
  vpc_id      = aws_vpc.main.id
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.service.id]
  }
  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.service.id]
  }
  tags = local.tags
}

resource "aws_db_subnet_group" "main" {
  name       = local.prefix
  subnet_ids = values(aws_subnet.private)[*].id
  tags       = local.tags
}

resource "aws_db_instance" "postgres" {
  identifier                      = "${local.prefix}-postgres"
  engine                          = "postgres"
  engine_version                  = "17"
  instance_class                  = var.environment == "live" ? "db.r7g.large" : "db.t4g.medium"
  allocated_storage               = var.environment == "live" ? 200 : 50
  max_allocated_storage           = var.environment == "live" ? 1000 : 200
  storage_type                    = "gp3"
  storage_encrypted               = true
  kms_key_id                      = aws_kms_key.platform.arn
  db_name                         = "whox_treasury"
  username                        = "whox_admin"
  manage_master_user_password     = true
  master_user_secret_kms_key_id   = aws_kms_key.platform.key_id
  db_subnet_group_name            = aws_db_subnet_group.main.name
  vpc_security_group_ids          = [aws_security_group.data.id]
  publicly_accessible             = false
  multi_az                        = true
  backup_retention_period         = var.environment == "live" ? 35 : 14
  copy_tags_to_snapshot           = true
  deletion_protection             = var.deletion_protection
  skip_final_snapshot             = false
  final_snapshot_identifier       = "${local.prefix}-final"
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]
  auto_minor_version_upgrade      = true
  apply_immediately               = false
  tags                            = local.tags
}

resource "aws_elasticache_subnet_group" "main" {
  name       = local.prefix
  subnet_ids = values(aws_subnet.private)[*].id
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id       = "${local.prefix}-redis"
  description                = "Short-lived cache, locks, and coordination"
  engine                     = "redis"
  node_type                  = var.environment == "live" ? "cache.r7g.large" : "cache.t4g.small"
  num_cache_clusters         = 2
  automatic_failover_enabled = true
  multi_az_enabled           = true
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = var.redis_auth_token
  auth_token_update_strategy = "ROTATE"
  kms_key_id                 = aws_kms_key.platform.arn
  subnet_group_name          = aws_elasticache_subnet_group.main.name
  security_group_ids         = [aws_security_group.data.id]
  snapshot_retention_limit   = var.environment == "live" ? 14 : 7
  apply_immediately          = false
  tags                       = local.tags
}

resource "aws_secretsmanager_secret" "broker_tokens" {
  name                    = "${local.prefix}/broker-token-vault"
  description             = "Envelope-encrypted per-user broker token records; execution and approved broker-sync tasks only"
  kms_key_id              = aws_kms_key.platform.arn
  recovery_window_in_days = 30
  tags                    = local.tags
}

resource "aws_secretsmanager_secret" "runtime" {
  for_each = {
    api-database-url            = "Full PostgreSQL URL for a login granted only whox_api_runtime"
    app-store-database-url      = "Full PostgreSQL URL for a login granted only whox_app_store_notifications"
    agent-database-url          = "Full PostgreSQL URL for a login granted only whox_agent_worker"
    execution-database-url      = "Full PostgreSQL URL for a login granted only whox_execution_worker"
    notification-database-url   = "Full PostgreSQL URL for a login granted only whox_notification_worker"
    market-data-database-url    = "Full PostgreSQL URL for a login granted only whox_market_data_worker"
    broker-sync-database-url    = "Full PostgreSQL URL for a login granted only whox_broker_sync_worker"
    session-signing-secret      = "API session signing secret; at least 32 random bytes"
    pairing-hash-pepper         = "Pairing-code hash pepper; at least 32 random bytes and distinct from the session secret"
    device-token-encryption-key = "Shared API/notification-worker APNs token-envelope key; at least 32 random bytes and distinct from session/pairing secrets"
    rate-limit-key-secret       = "API client-address HMAC secret; at least 32 random bytes and distinct from all other API secrets"
    apple-root-ca-bundle        = "Apple PKI root certificate PEM bundle for official StoreKit signed-data verification"
    apns-private-key            = "Apple APNs token-authentication EC P-256 private key; notification worker only"
    market-data-provider-token  = "Market-data provider bearer token; populate only after provider approval"
    hermes-api-key              = "Hermes research-only API bearer key; agent orchestrator only and never broker-capable"
  }
  name                    = "${local.prefix}/${each.key}"
  description             = each.value
  kms_key_id              = aws_kms_key.platform.arn
  recovery_window_in_days = 30
  tags                    = local.tags
}

resource "aws_secretsmanager_secret" "redis_url" {
  name                    = "${local.prefix}/redis-url"
  description             = "Complete TLS Redis URL used by API and worker runtimes"
  kms_key_id              = aws_kms_key.platform.arn
  recovery_window_in_days = 30
  tags                    = local.tags
}

resource "aws_secretsmanager_secret_version" "redis_url" {
  secret_id     = aws_secretsmanager_secret.redis_url.id
  secret_string = "rediss://:${urlencode(var.redis_auth_token)}@${aws_elasticache_replication_group.redis.primary_endpoint_address}:${aws_elasticache_replication_group.redis.port}/0"
}

resource "aws_ecs_cluster" "main" {
  name = local.prefix
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
  tags = local.tags
}

resource "aws_cloudwatch_log_group" "service" {
  for_each          = local.service_names
  name              = "/whox/${var.environment}/${each.key}"
  retention_in_days = var.environment == "live" ? 90 : 30
  kms_key_id        = aws_kms_key.platform.arn
  tags              = local.tags
}

data "aws_iam_policy_document" "task_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task_execution" {
  for_each           = local.service_names
  name               = "${local.prefix}-${each.key}-execution"
  assume_role_policy = data.aws_iam_policy_document.task_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "task_execution" {
  for_each   = local.service_names
  role       = aws_iam_role.task_execution[each.key].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

locals {
  service_runtime_secret_arns = {
    api = [
      aws_secretsmanager_secret.runtime["api-database-url"].arn,
      aws_secretsmanager_secret.runtime["app-store-database-url"].arn,
      aws_secretsmanager_secret.redis_url.arn,
      aws_secretsmanager_secret.runtime["session-signing-secret"].arn,
      aws_secretsmanager_secret.runtime["pairing-hash-pepper"].arn,
      aws_secretsmanager_secret.runtime["device-token-encryption-key"].arn,
      aws_secretsmanager_secret.runtime["rate-limit-key-secret"].arn,
      aws_secretsmanager_secret.runtime["apple-root-ca-bundle"].arn,
    ]
    agent-orchestrator = [
      aws_secretsmanager_secret.runtime["agent-database-url"].arn,
      aws_secretsmanager_secret.redis_url.arn,
      aws_secretsmanager_secret.runtime["hermes-api-key"].arn,
    ]
    execution-worker = [
      aws_secretsmanager_secret.runtime["execution-database-url"].arn,
      aws_secretsmanager_secret.redis_url.arn,
    ]
    notification-worker = [
      aws_secretsmanager_secret.runtime["notification-database-url"].arn,
      aws_secretsmanager_secret.redis_url.arn,
      aws_secretsmanager_secret.runtime["device-token-encryption-key"].arn,
      aws_secretsmanager_secret.runtime["apns-private-key"].arn,
    ]
    market-data-service = [
      aws_secretsmanager_secret.runtime["market-data-database-url"].arn,
      aws_secretsmanager_secret.redis_url.arn,
      aws_secretsmanager_secret.runtime["market-data-provider-token"].arn,
    ]
    broker-sync-service = [
      aws_secretsmanager_secret.runtime["broker-sync-database-url"].arn,
    ]
  }
}

data "aws_iam_policy_document" "task_execution_runtime_secrets" {
  for_each = local.service_runtime_secret_arns
  statement {
    sid       = "ReadExactRuntimeSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = each.value
  }
  statement {
    sid       = "DecryptRuntimeSecrets"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.platform.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${data.aws_region.current.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "task_execution_runtime_secrets" {
  for_each = local.service_runtime_secret_arns
  name     = "exact-runtime-secrets"
  role     = aws_iam_role.task_execution[each.key].id
  policy   = data.aws_iam_policy_document.task_execution_runtime_secrets[each.key].json
}

resource "aws_iam_role" "task" {
  for_each           = local.service_names
  name               = "${local.prefix}-${each.key}-task"
  assume_role_policy = data.aws_iam_policy_document.task_assume.json
  tags               = local.tags
}

data "aws_iam_policy_document" "execution" {
  statement {
    sid       = "ReadBrokerTokenVault"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.broker_tokens.arn]
  }
  statement {
    sid       = "DecryptBrokerTokens"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.platform.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${data.aws_region.current.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "execution" {
  name   = "execution-boundary"
  role   = aws_iam_role.task["execution-worker"].id
  policy = data.aws_iam_policy_document.execution.json
}

data "aws_iam_policy_document" "broker_sync" {
  statement {
    sid       = "ReadBrokerTokenVault"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.broker_tokens.arn]
  }
  statement {
    sid       = "DecryptBrokerTokens"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.platform.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${data.aws_region.current.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "broker_sync" {
  name   = "broker-token-boundary"
  role   = aws_iam_role.task["broker-sync-service"].id
  policy = data.aws_iam_policy_document.broker_sync.json
}

# This is the intentional public HTTPS entry point; WAF, TLS, rate limiting, and
# a private target group constrain it. Re-evaluate this exception annually.
#trivy:ignore:AVD-AWS-0053:exp:2027-08-01
resource "aws_lb" "api" {
  name                       = substr("${local.prefix}-api", 0, 32)
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = values(aws_subnet.public)[*].id
  enable_deletion_protection = var.deletion_protection
  drop_invalid_header_fields = true
  tags                       = local.tags
}

resource "aws_lb_target_group" "api" {
  name        = substr("${local.prefix}-api", 0, 32)
  port        = 8080
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id
  health_check {
    path     = "/readyz"
    matcher  = "200"
    interval = 30
    timeout  = 5
  }
  deregistration_delay = 30
  tags                 = local.tags
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.api.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_wafv2_web_acl" "api" {
  name  = "${local.prefix}-api"
  scope = "REGIONAL"
  default_action {
    allow {}
  }
  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.prefix}-waf"
    sampled_requests_enabled   = true
  }
  rule {
    name     = "AWSManagedCommon"
    priority = 10
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "common"
      sampled_requests_enabled   = true
    }
  }
  rule {
    name     = "GlobalRateLimit"
    priority = 20
    action {
      block {}
    }
    statement {
      rate_based_statement {
        aggregate_key_type = "IP"
        limit              = 2000
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "rate-limit"
      sampled_requests_enabled   = true
    }
  }
  tags = local.tags
}

resource "aws_wafv2_web_acl_association" "api" {
  resource_arn = aws_lb.api.arn
  web_acl_arn  = aws_wafv2_web_acl.api.arn
}

locals {
  approved_market_data_provider_ids = [
    for provider in split(",", var.approved_market_data_providers) : trimspace(provider)
    if trimspace(provider) != ""
  ]
  market_provider_configured = (
    startswith(var.market_data_provider_url, "https://") &&
    var.market_data_provider_url == trimspace(var.market_data_provider_url) &&
    !strcontains(var.market_data_provider_url, "@") &&
    !strcontains(var.market_data_provider_url, "?") &&
    !strcontains(var.market_data_provider_url, "#") &&
    can(regex("^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$", var.market_data_provider_id)) &&
    length(local.approved_market_data_provider_ids) > 0 &&
    alltrue([for provider in local.approved_market_data_provider_ids : can(regex("^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$", provider))]) &&
    contains(local.approved_market_data_provider_ids, var.market_data_provider_id)
  )
  hermes_provider_configured = (
    var.hermes_base_url == "https://treasury-bot.whox.ai/v1" &&
    var.hermes_model == "treasury-bot" &&
    var.hermes_research_profile_tools_disabled
  )
  worker_services = {
    agent-orchestrator = {
      entrypoint           = "services/agent-orchestrator/dist/worker-main.js"
      database_secret_name = "agent-database-url"
      health_port          = 9101
      desired_count        = var.agent_orchestrator_desired_count
      environment = [
        { name = "MARKET_DATA_PROVIDER_ID", value = var.market_data_provider_id },
        { name = "APPROVED_MARKET_DATA_PROVIDERS", value = var.approved_market_data_providers },
        { name = "AGENT_SCHEDULER_POLL_MS", value = tostring(var.agent_scheduler_poll_ms) },
        { name = "AGENT_SCHEDULER_BATCH_SIZE", value = tostring(var.agent_scheduler_batch_size) },
        { name = "AGENT_SCHEDULER_MAX_OUTSTANDING_JOBS", value = tostring(var.agent_scheduler_max_outstanding_jobs) },
        { name = "AGENT_SCHEDULER_LAG_ALERT_SECONDS", value = tostring(var.agent_scheduler_lag_alert_seconds) },
        { name = "HERMES_BASE_URL", value = var.hermes_base_url },
        { name = "HERMES_MODEL", value = var.hermes_model },
        { name = "HERMES_RESEARCH_PROFILE_TOOLS_DISABLED", value = tostring(var.hermes_research_profile_tools_disabled) },
      ]
    }
    execution-worker = {
      entrypoint           = "services/execution-worker/dist/worker-main.js"
      database_secret_name = "execution-database-url"
      health_port          = 9102
      desired_count        = var.execution_desired_count
      environment = [
        { name = "BROKER_TOKEN_SECRET_ARN", value = aws_secretsmanager_secret.broker_tokens.arn },
        { name = "MARKET_DATA_PROVIDER_ID", value = var.market_data_provider_id },
        { name = "APPROVED_MARKET_DATA_PROVIDERS", value = var.approved_market_data_providers },
      ]
    }
    notification-worker = {
      entrypoint           = "services/notification-worker/dist/worker-main.js"
      database_secret_name = "notification-database-url"
      health_port          = 9103
      desired_count        = var.notification_desired_count
      environment = [
        { name = "APNS_TEAM_ID", value = var.apns_team_id },
        { name = "APNS_KEY_ID", value = var.apns_key_id },
        { name = "APNS_TOPIC", value = var.apns_topic },
        { name = "APNS_ENVIRONMENTS", value = var.apns_environments },
      ]
    }
    market-data-service = {
      entrypoint           = "services/market-data-service/dist/worker-main.js"
      database_secret_name = "market-data-database-url"
      health_port          = 9104
      desired_count        = var.market_data_desired_count
      environment = [
        { name = "MARKET_DATA_PROVIDER_URL", value = var.market_data_provider_url },
        { name = "MARKET_DATA_PROVIDER_ID", value = var.market_data_provider_id },
        { name = "APPROVED_MARKET_DATA_PROVIDERS", value = var.approved_market_data_providers },
      ]
    }
    broker-sync-service = {
      entrypoint           = "services/broker-sync-service/dist/worker-main.js"
      database_secret_name = "broker-sync-database-url"
      health_port          = 9105
      desired_count        = var.broker_sync_desired_count
      environment = [
        { name = "BROKER_TOKEN_SECRET_ARN", value = aws_secretsmanager_secret.broker_tokens.arn },
        { name = "BROKER_SNAPSHOT_MAX_AGE_SECONDS", value = tostring(var.broker_snapshot_max_age_seconds) },
        { name = "BROKER_SYNC_INTERVAL_SECONDS", value = tostring(var.broker_sync_interval_seconds) },
      ]
    }
  }
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.prefix}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.task_execution["api"].arn
  task_role_arn            = aws_iam_role.task["api"].arn
  container_definitions = jsonencode([{
    name         = "api"
    image        = var.api_image
    essential    = true
    command      = ["node", "services/api/dist/index.js"]
    portMappings = [{ containerPort = 8080, protocol = "tcp" }]
    environment = concat(local.release_flags, [
      { name = "APP_ENV", value = var.environment },
      { name = "HOST", value = "0.0.0.0" },
      { name = "PORT", value = "8080" },
      { name = "BROKER_TOKEN_ACCESS", value = "denied" },
      { name = "PUBLIC_API_URL", value = var.public_api_url },
      { name = "CONNECT_WEB_URL", value = var.connect_web_url },
      { name = "ADMIN_WEB_URL", value = var.admin_web_url },
      { name = "CORS_ALLOWED_ORIGINS", value = join(",", var.cors_allowed_origins) },
      { name = "APPLE_CLIENT_ID", value = var.apple_client_id },
      { name = "APPLE_BUNDLE_ID", value = var.apple_bundle_id },
      { name = "APPLE_APP_ID", value = tostring(var.apple_app_id) },
      { name = "STOREKIT_ENVIRONMENTS", value = var.storekit_environments },
      { name = "TRUSTED_PROXY_HOPS", value = "1" },
    ])
    secrets = [
      { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.runtime["api-database-url"].arn },
      { name = "APP_STORE_DATABASE_URL", valueFrom = aws_secretsmanager_secret.runtime["app-store-database-url"].arn },
      { name = "REDIS_URL", valueFrom = aws_secretsmanager_secret.redis_url.arn },
      { name = "SESSION_SIGNING_SECRET", valueFrom = aws_secretsmanager_secret.runtime["session-signing-secret"].arn },
      { name = "PAIRING_HASH_PEPPER", valueFrom = aws_secretsmanager_secret.runtime["pairing-hash-pepper"].arn },
      { name = "DEVICE_TOKEN_ENCRYPTION_KEY", valueFrom = aws_secretsmanager_secret.runtime["device-token-encryption-key"].arn },
      { name = "RATE_LIMIT_KEY_SECRET", valueFrom = aws_secretsmanager_secret.runtime["rate-limit-key-secret"].arn },
      { name = "APPLE_ROOT_CA_BUNDLE", valueFrom = aws_secretsmanager_secret.runtime["apple-root-ca-bundle"].arn },
    ]
    healthCheck = {
      command     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:8080/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))\""]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 20
    }
    logConfiguration       = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.service["api"].name, awslogs-region = data.aws_region.current.region, awslogs-stream-prefix = "api" } }
    readonlyRootFilesystem = true
  }])
  tags = local.tags
}

resource "aws_ecs_task_definition" "worker" {
  for_each                 = local.worker_services
  family                   = "${local.prefix}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.task_execution[each.key].arn
  task_role_arn            = aws_iam_role.task[each.key].arn
  container_definitions = jsonencode([{
    name         = each.key
    image        = var.worker_image
    essential    = true
    command      = ["node", each.value.entrypoint]
    portMappings = [{ containerPort = each.value.health_port, protocol = "tcp" }]
    environment = concat(local.release_flags, [
      { name = "APP_ENV", value = var.environment },
      { name = "HEALTH_PORT", value = tostring(each.value.health_port) },
    ], each.value.environment)
    secrets = concat([
      { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.runtime[each.value.database_secret_name].arn },
      ], each.key == "broker-sync-service" ? [] : [
      { name = "REDIS_URL", valueFrom = aws_secretsmanager_secret.redis_url.arn },
      ], each.key == "market-data-service" ? [
      { name = "MARKET_DATA_PROVIDER_TOKEN", valueFrom = aws_secretsmanager_secret.runtime["market-data-provider-token"].arn },
      ] : each.key == "agent-orchestrator" ? [
      { name = "HERMES_API_KEY", valueFrom = aws_secretsmanager_secret.runtime["hermes-api-key"].arn },
      ] : [], each.key == "notification-worker" ? [
      { name = "DEVICE_TOKEN_ENCRYPTION_KEY", valueFrom = aws_secretsmanager_secret.runtime["device-token-encryption-key"].arn },
      { name = "APNS_PRIVATE_KEY", valueFrom = aws_secretsmanager_secret.runtime["apns-private-key"].arn },
    ] : [])
    healthCheck = {
      command     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:${each.value.health_port}/${each.key == "broker-sync-service" ? "readyz" : "healthz"}').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))\""]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 20
    }
    logConfiguration       = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.service[each.key].name, awslogs-region = data.aws_region.current.region, awslogs-stream-prefix = "worker" } }
    readonlyRootFilesystem = true
  }])
  tags = local.tags
}

resource "aws_ecs_service" "api" {
  name            = "api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.runtime_secrets_bootstrapped ? var.api_desired_count : 0
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = values(aws_subnet.private)[*].id
    security_groups  = [aws_security_group.service.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 8080
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  depends_on = [aws_lb_listener.https]
  tags       = local.tags
}

resource "aws_ecs_service" "worker" {
  for_each        = local.worker_services
  name            = each.key
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.worker[each.key].arn
  desired_count = (
    var.runtime_secrets_bootstrapped &&
    (each.key != "market-data-service" || local.market_provider_configured)
    ? each.value.desired_count : 0
  )
  launch_type = "FARGATE"
  network_configuration {
    subnets          = values(aws_subnet.private)[*].id
    security_groups  = [aws_security_group.service.id]
    assign_public_ip = false
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  lifecycle {
    precondition {
      condition     = each.key != "execution-worker" || var.environment != "live" || each.value.desired_count == 0
      error_message = "Live execution-worker capacity must remain zero until the approved Robinhood order-schema mapper exists."
    }
    precondition {
      condition     = each.key != "broker-sync-service" || (each.value.desired_count == 0 && var.broker_sync_interval_seconds <= var.broker_snapshot_max_age_seconds - 5)
      error_message = "The standard broker-sync artifact is Paper-only, must remain scaled to zero without a reviewed connector, and requires its interval to stay inside the snapshot validity window."
    }
    precondition {
      condition     = each.key != "market-data-service" || each.value.desired_count == 0 || local.market_provider_configured
      error_message = "Market-data capacity requires an HTTPS URL plus a valid MARKET_DATA_PROVIDER_ID present in APPROVED_MARKET_DATA_PROVIDERS."
    }
    precondition {
      condition = !var.runtime_secrets_bootstrapped || var.environment != "paper" || !contains(["agent-orchestrator", "execution-worker"], each.key) || each.value.desired_count == 0 || (
        var.market_data_desired_count > 0 && local.market_provider_configured
      )
      error_message = "Paper orchestration and execution require an active, explicitly approved market-data producer."
    }
    precondition {
      condition     = !var.runtime_secrets_bootstrapped || each.key != "agent-orchestrator" || each.value.desired_count == 0 || local.hermes_provider_configured
      error_message = "Agent-orchestrator capacity requires the exact reviewed Hermes endpoint/model and an operator attestation that every provider-side tool and persistent memory surface is disabled."
    }
    precondition {
      condition = each.key != "notification-worker" || each.value.desired_count == 0 || (
        can(regex("^[A-Z0-9]{8,20}$", var.apns_team_id)) &&
        can(regex("^[A-Z0-9]{8,20}$", var.apns_key_id)) &&
        can(regex("^[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+$", var.apns_topic)) &&
        contains(["sandbox", "production", "sandbox,production", "production,sandbox"], var.apns_environments)
      )
      error_message = "Reviewed APNs team/key IDs, bundle topic, and allowed environment(s) are required before notification capacity can be enabled."
    }
  }
  tags = local.tags
}

locals {
  active_worker_services = {
    for name, service in local.worker_services : name => service
    if var.runtime_secrets_bootstrapped && service.desired_count > 0 &&
    (name != "market-data-service" || local.market_provider_configured)
  }
}

# Durable jobs live in PostgreSQL's queue_jobs table. Alert on the health of the
# ECS consumers that lease those rows instead of monitoring an unrelated queue.
resource "aws_cloudwatch_metric_alarm" "worker_running_tasks" {
  for_each            = local.active_worker_services
  alarm_name          = "${local.prefix}-${each.key}-running-tasks"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "RunningTaskCount"
  namespace           = "ECS/ContainerInsights"
  period              = 60
  statistic           = "Minimum"
  threshold           = each.value.desired_count
  treat_missing_data  = "breaching"
  alarm_description   = "${each.key} has fewer healthy PostgreSQL durable-queue consumers than configured"
  alarm_actions       = [var.alert_topic_arn]
  ok_actions          = [var.alert_topic_arn]
  dimensions = {
    ClusterName = aws_ecs_cluster.main.name
    ServiceName = aws_ecs_service.worker[each.key].name
  }
  tags = local.tags
}

resource "aws_cloudwatch_log_metric_filter" "paper_scheduler_lag" {
  name           = "${local.prefix}-paper-scheduler-lag"
  log_group_name = aws_cloudwatch_log_group.service["agent-orchestrator"].name
  pattern        = "{ $.event = \"paper_scheduler_lag\" }"

  metric_transformation {
    name          = "PaperSchedulerLagEvents"
    namespace     = "WHOX/Treasury"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "paper_scheduler_lag" {
  alarm_name          = "${local.prefix}-paper-scheduler-lag"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.paper_scheduler_lag.metric_transformation[0].name
  namespace           = aws_cloudwatch_log_metric_filter.paper_scheduler_lag.metric_transformation[0].namespace
  period              = 60
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_description   = "Paper agent scheduling lag exceeded the configured health threshold"
  alarm_actions       = [var.alert_topic_arn]
  ok_actions          = [var.alert_topic_arn]
  tags                = local.tags
}
