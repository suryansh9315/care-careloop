variable "name" {
  description = "Name prefix for all resources."
  type        = string
  default     = "careloop"
}

variable "region" {
  description = "AWS region."
  type        = string
  default     = "us-east-1"
}

variable "aws_profile" {
  description = "Local AWS CLI profile used to authenticate before Terraform assumes the deployment role."
  type        = string
}

variable "target_account_id" {
  description = "AWS account ID that Terraform is permitted to deploy into."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.target_account_id))
    error_message = "target_account_id must be a 12-digit AWS account ID."
  }
}

variable "assume_role_name" {
  description = "IAM role name Terraform assumes in the target account."
  type        = string
}

variable "instance_type" {
  description = "EC2 instance type for the bridge."
  type        = string
  default     = "t3.small"
}

variable "domain" {
  description = "Public hostname Twilio connects to. Its DNS A record must point at the Elastic IP before Caddy can issue a certificate."
  type        = string
}

variable "git_repo" {
  description = "Git URL the instance clones the bridge from. For a private repo use a tokenized URL (https://<TOKEN>@github.com/you/repo.git)."
  type        = string
}

variable "env_parameter_name" {
  description = "SSM SecureString parameter holding the bridge's runtime environment."
  type        = string
  default     = "/careloop/bridge-env"
}
