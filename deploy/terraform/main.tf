terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region              = var.region
  profile             = var.aws_profile
  allowed_account_ids = [var.target_account_id]

  assume_role {
    role_arn = "arn:aws:iam::${var.target_account_id}:role/${var.assume_role_name}"
  }
}

# --- Networking -------------------------------------------------------------
# The bridge is a single public HTTPS/WSS endpoint. Twilio must be able to
# reach it, so it sits in the default VPC's public subnet behind Caddy.

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

resource "aws_security_group" "bridge" {
  name        = "${var.name}-bridge"
  description = "CareLoop bridge — public HTTPS/WSS only"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "HTTP (ACME challenge and redirect to HTTPS)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS and WSS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # No SSH ingress by design. Operational access is through SSM Session Manager,
  # which leaves an auditable trail and needs no open port or key material.

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.name}-bridge" }
}

# --- AMI --------------------------------------------------------------------
# Resolved through Canonical's public SSM parameter so the AMI id is never
# pinned to a stale snapshot in this file.

data "aws_ssm_parameter" "ubuntu" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}

# --- Instance role ----------------------------------------------------------

resource "aws_iam_role" "bridge" {
  name = "${var.name}-bridge-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.bridge.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# Read access is scoped to this one parameter rather than the whole store.
resource "aws_iam_role_policy" "read_env" {
  name = "${var.name}-read-bridge-env"
  role = aws_iam_role.bridge.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:GetParameters"]
        Resource = aws_ssm_parameter.bridge_env.arn
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = "*"
        Condition = {
          StringEquals = { "kms:ViaService" = "ssm.${var.region}.amazonaws.com" }
        }
      }
    ]
  })
}

resource "aws_iam_instance_profile" "bridge" {
  name = "${var.name}-bridge-profile"
  role = aws_iam_role.bridge.name
}

# --- Runtime configuration --------------------------------------------------
# Secrets live in an encrypted SSM parameter, not in this repo and not in user
# data. `terraform apply` does not set the value — populate it out of band with:
#
#   aws ssm put-parameter --name /careloop/bridge-env --type SecureString \
#     --value file://.env --overwrite

resource "aws_ssm_parameter" "bridge_env" {
  name        = var.env_parameter_name
  description = "CareLoop bridge runtime environment"
  type        = "SecureString"
  value       = "PLACEHOLDER — set out of band, see comment in main.tf"

  lifecycle {
    ignore_changes = [value]
  }
}

# --- Instance ---------------------------------------------------------------

resource "aws_instance" "bridge" {
  ami                    = data.aws_ssm_parameter.ubuntu.value
  instance_type          = var.instance_type
  subnet_id              = data.aws_subnets.default.ids[0]
  vpc_security_group_ids = [aws_security_group.bridge.id]
  iam_instance_profile   = aws_iam_instance_profile.bridge.name

  user_data = templatefile("${path.module}/user-data.sh", {
    public_host        = var.domain
    env_parameter_name = var.env_parameter_name
    region             = var.region
    repo_url           = var.git_repo
  })

  # A user-data edit must re-bootstrap: without this Terraform updates the
  # attribute in place and cloud-init never re-runs, leaving stale code live.
  user_data_replace_on_change = true

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
    encrypted   = true
  }

  metadata_options {
    http_tokens = "required" # IMDSv2 only
  }

  tags = { Name = "${var.name}-bridge" }
}

resource "aws_eip" "bridge" {
  instance = aws_instance.bridge.id
  domain   = "vpc"
  tags     = { Name = "${var.name}-bridge" }
}
