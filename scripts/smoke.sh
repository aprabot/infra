#!/usr/bin/env bash
# Quick checks that a stage is up after a deploy. Read-only.
#   scripts/smoke.sh beta|prod
# Needs AWS credentials for that stage's account (to find its URLs).
set -euo pipefail
STAGE="${1:?usage: smoke.sh beta|prod}"
REGION=us-east-1
INFRA="$(cd "$(dirname "$0")/.." && pwd)"
SITE=$(aws cloudformation describe-stacks --region $REGION --stack-name AprabotSite \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionDomain'].OutputValue" --output text)
API=$(aws apigatewayv2 get-apis --region $REGION --query "Items[?Name=='aprabot-forecast'].ApiEndpoint" --output text)
FAIL=0
check() {  # name, url, expected status
  local code; code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$2")
  if [ "$code" = "$3" ]; then echo "ok    $1 ($code)"; else echo "FAIL  $1: got $code, expected $3"; FAIL=1; fi
}
check 'home page'            "https://$SITE/" 200
check 'dashboard page'       "https://$SITE/dashboard/" 200
check 'about page (Pages-style URL)' "https://$SITE/about" 200
check 'dashboard script'     "https://$SITE/js/ads.js" 200
# Without a token the API must refuse (401), which proves routes and the
# Cognito authorizer are in place without touching any data.
check 'API forecast (no token)'     "$API/forecast" 401
check 'API campaigns (no token)'    "$API/amplify-campaigns" 401
check 'API OAuth status (no token)' "$API/amplify-oauth/status" 401
if [ "$STAGE" != prod ]; then
  POOL=$(python3 -c "import json; print(json.load(open('$INFRA/stages.json'))['$STAGE']['userPoolId'])")
  if curl -s --max-time 20 "https://$SITE/js/auth.js" | grep -qF "$POOL"; then echo "ok    site uses the $STAGE user pool"
  else echo "FAIL  site doesn't use the $STAGE user pool"; FAIL=1; fi
fi
exit $FAIL
