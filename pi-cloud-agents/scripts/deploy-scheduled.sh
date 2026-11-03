#!/usr/bin/env bash
# Builds and deploys the pi-tick-aws stack (launch Lambda, Scheduler role, `pi-tick` schedule
# group) next to an existing pi-cloud-agents core stack. Uses AWS_PROFILE / AWS_REGION.
#   scripts/deploy-scheduled.sh [core-stack-name] [launcher-stack-name]
set -euo pipefail
cd "$(dirname "$0")/.."

core_stack=${1:-pi-cloud-agents-core}
stack=${2:-pi-tick-aws}

output() {
  aws cloudformation describe-stacks --stack-name "$core_stack" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
bucket=$(output BucketName)
execution_role=$(output ExecutionRoleArn)

npm run --silent build:scheduled
key="tick/launcher/$(shasum -a 256 dist/scheduled/launcher.zip | cut -c1-16).zip"
aws s3 cp --only-show-errors --sse AES256 dist/scheduled/launcher.zip "s3://$bucket/$key"

aws cloudformation deploy \
  --stack-name "$stack" \
  --template-file scheduled/template.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides "BucketName=$bucket" "ExecutionRoleArn=$execution_role" "CodeKey=$key"

aws cloudformation describe-stacks --stack-name "$stack" --query 'Stacks[0].Outputs' --output table
