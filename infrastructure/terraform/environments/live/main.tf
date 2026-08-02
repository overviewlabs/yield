terraform {
  required_version = ">= 1.8.0"
  backend "s3" {}
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.80, < 7.0"
    }
  }
}

provider "aws" { region = var.aws_region }

variable "aws_region" {
  type    = string
  default = "us-east-1"
}
variable "certificate_arn" { type = string }
variable "api_image" { type = string }
variable "worker_image" { type = string }
variable "public_api_url" { type = string }
variable "connect_web_url" { type = string }
variable "admin_web_url" { type = string }
variable "cors_allowed_origins" { type = list(string) }
variable "redis_auth_token" {
  type      = string
  sensitive = true
}
variable "alert_topic_arn" { type = string }
variable "apple_client_id" { type = string }
variable "apple_bundle_id" { type = string }
variable "apple_app_id" { type = number }
variable "storekit_environments" { type = string }
variable "runtime_secrets_bootstrapped" {
  type    = bool
  default = false
}
variable "market_data_provider_url" {
  type    = string
  default = ""
}
variable "market_data_provider_id" {
  type    = string
  default = ""
}
variable "approved_market_data_providers" {
  type    = string
  default = ""
}
variable "hermes_base_url" {
  type    = string
  default = "https://treasury-bot.whox.ai/v1"
}
variable "hermes_model" {
  type    = string
  default = "treasury-bot"
}
variable "hermes_research_profile_tools_disabled" {
  type    = bool
  default = false
}
variable "agent_scheduler_poll_ms" {
  type    = number
  default = 15000
}
variable "agent_scheduler_batch_size" {
  type    = number
  default = 250
}
variable "agent_scheduler_max_outstanding_jobs" {
  type    = number
  default = 1000
}
variable "agent_scheduler_lag_alert_seconds" {
  type    = number
  default = 300
}
variable "market_data_desired_count" {
  type    = number
  default = 0
}
variable "notification_desired_count" {
  type    = number
  default = 0
}
variable "apns_team_id" {
  type    = string
  default = ""
}
variable "apns_key_id" {
  type    = string
  default = ""
}
variable "apns_topic" {
  type    = string
  default = ""
}
variable "apns_environments" {
  type    = string
  default = "production"
}

module "platform" {
  source                                 = "../../modules/platform"
  name                                   = "whox-treasury"
  environment                            = "live"
  vpc_cidr                               = "10.84.0.0/16"
  availability_zones                     = ["${var.aws_region}a", "${var.aws_region}b", "${var.aws_region}c"]
  api_image                              = var.api_image
  worker_image                           = var.worker_image
  certificate_arn                        = var.certificate_arn
  public_api_url                         = var.public_api_url
  connect_web_url                        = var.connect_web_url
  admin_web_url                          = var.admin_web_url
  cors_allowed_origins                   = var.cors_allowed_origins
  redis_auth_token                       = var.redis_auth_token
  alert_topic_arn                        = var.alert_topic_arn
  apple_client_id                        = var.apple_client_id
  apple_bundle_id                        = var.apple_bundle_id
  apple_app_id                           = var.apple_app_id
  storekit_environments                  = var.storekit_environments
  execution_desired_count                = 0
  agent_orchestrator_desired_count       = 0
  broker_sync_desired_count              = 0
  market_data_desired_count              = var.market_data_desired_count
  market_data_provider_url               = var.market_data_provider_url
  market_data_provider_id                = var.market_data_provider_id
  approved_market_data_providers         = var.approved_market_data_providers
  hermes_base_url                        = var.hermes_base_url
  hermes_model                           = var.hermes_model
  hermes_research_profile_tools_disabled = var.hermes_research_profile_tools_disabled
  agent_scheduler_poll_ms                = var.agent_scheduler_poll_ms
  agent_scheduler_batch_size             = var.agent_scheduler_batch_size
  agent_scheduler_max_outstanding_jobs   = var.agent_scheduler_max_outstanding_jobs
  agent_scheduler_lag_alert_seconds      = var.agent_scheduler_lag_alert_seconds
  notification_desired_count             = var.notification_desired_count
  apns_team_id                           = var.apns_team_id
  apns_key_id                            = var.apns_key_id
  apns_topic                             = var.apns_topic
  apns_environments                      = var.apns_environments
  runtime_secrets_bootstrapped           = var.runtime_secrets_bootstrapped
  deletion_protection                    = true
  tags                                   = { CostCenter = "treasury-live" }
}
