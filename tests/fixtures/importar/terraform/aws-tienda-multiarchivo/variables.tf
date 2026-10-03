# Variables y locales del stack.

variable "environment" {
  type        = string
  description = "Nombre del entorno"
  default     = "production"
}

variable "region" {
  type    = string
  default = "eu-west-1"
}

variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}

variable "db_password" {
  type      = string
  sensitive = true
}

locals {
  name = "tienda-${var.environment}"
  azs  = ["${var.region}a", "${var.region}b"]

  common_tags = {
    Stack = "tienda"
  }
}

