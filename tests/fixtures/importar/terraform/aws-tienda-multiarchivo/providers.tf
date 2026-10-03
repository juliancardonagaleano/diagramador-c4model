# Providers y backend del stack (el resto de archivos de esta carpeta se leen juntos con él).
terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.40"
    }
  }

  backend "s3" {
    bucket = "tienda-tfstate"
    key    = "produccion/terraform.tfstate"
    region = "eu-west-1"
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Environment = var.environment
      Project     = "tienda"
      Owner       = "plataforma"
    }
  }
}

