# FIXTURE MIT SOLLWERTEN — Zeilennummern der Parser-Ausgabe (hcl.ts).
#
# WOFUER: Diese Datei enthaelt absichtlich den Fall, bei dem die gemeldete
# Zeilennummer frueher falsch war: der ERSTE Eintrag eines locals-Blocks bekam
# die Zeilennummer der "locals {"-Kopfzeile statt seiner eigenen. Ursache ist
# das fuehrende \s* des Musters zusammen mit der Suche, die unmittelbar hinter
# der oeffnenden Klammer ansetzt — also noch auf der Kopfzeile.
# An nachgebautem Material lagen dadurch 49,7 % der local-Zeilennummern daneben.
#
# ZWEITENS enthaelt die Datei einen vollstaendigen terraform-Block mit
# required_providers. Der deckt hcl.ts:154 ab (substring MIT Endposition). Diese
# Stelle ist bewusst NICHT umgebaut worden: sie laeuft einmal je Datei, nicht je
# Treffer, und ist damit linear. In meinem nachgebauten Material fehlte ein
# terraform-Block vollstaendig — die Stelle wurde dort also nie durchlaufen.
#
# SOLL (Stand ab dem trefferZeile-Fix, Symbol -> Zeile die es tragen MUSS):
#   local [local.name_prefix] -> Zeile 66   (erster Eintrag des locals-Blocks)
#   local [local.common_tags] -> Zeile 67
#   class [terraform]         -> Zeile 26
# Der ALTE Stand meldete fuer "local.name_prefix" eine Zeile zu frueh.
#
# PRUEFEN: parse() auf diese Datei anwenden und die line_start-Werte gegen die
# Liste oben halten. Wenn du diese Datei aenderst, ZIEH DIE NUMMERN OBEN NACH —
# sie sind der Sollwert.

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  backend "s3" {
    bucket = "synapse-tfstate"
    key    = "prod/terraform.tfstate"
    region = "eu-central-1"
  }
}

provider "aws" {
  region = var.aws_region
}

variable "aws_region" {
  description = "AWS region for deployment"
  type        = string
  default     = "eu-central-1"
}

variable "instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t3.medium"
}

variable "tags" {
  type = map(string)
  default = {
    Project = "synapse"
    Env     = "production"
  }
}

locals {
  name_prefix = "synapse-${var.aws_region}"
  common_tags = merge(var.tags, { ManagedBy = "terraform" })
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-*"]
  }
}

resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  tags = merge(local.common_tags, { Name = "${local.name_prefix}-vpc" })
}

resource "aws_instance" "api" {
  ami           = data.aws_ami.ubuntu.id
  instance_type = var.instance_type
  subnet_id     = aws_subnet.public.id
  tags = merge(local.common_tags, { Name = "${local.name_prefix}-api" })
}

resource "aws_subnet" "public" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.0.1.0/24"
}

module "database" {
  source        = "./modules/rds"
  vpc_id        = aws_vpc.main.id
  instance_type = "db.t3.medium"
}

output "api_public_ip" {
  value       = aws_instance.api.public_ip
  description = "Public IP of the API server"
}

output "vpc_id" {
  value = aws_vpc.main.id
}

# TODO: add auto-scaling group
# FIXME: missing security groups
