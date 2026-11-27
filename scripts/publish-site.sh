#!/usr/bin/env bash
# Publish the website (a commit of aprabot/homepage) to a stage's S3 bucket
# and CloudFront distribution (stack AprabotSite).
#   scripts/publish-site.sh beta|prod [homepage-ref]
# Needs AWS credentials for that stage's account. Only committed files are
# sent, never the working tree. Server code, notes and repo files stay out.
# Every stage except prod gets its own backend swapped in (API, Cognito), a
# "Beta" badge and noindex.
set -euo pipefail
STAGE="${1:?usage: publish-site.sh beta|prod [ref]}"
REF="${2:-HEAD}"
INFRA="$(cd "$(dirname "$0")/.." && pwd)"
HOMEPAGE="${HOMEPAGE_REPO:-$INFRA/../homepage}"
REGION=us-east-1

val() { python3 -c "import json,sys; print(json.load(open('$INFRA/stages.json'))[sys.argv[1]][sys.argv[2]])" "$1" "$2"; }
out() { aws cloudformation describe-stacks --region $REGION --stack-name AprabotSite \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
api_id() { aws apigatewayv2 get-apis --region $REGION --query "Items[?Name=='aprabot-forecast'].ApiId" --output text; }

BUCKET=$(out BucketName); DISTRIBUTION=$(out DistributionId)
[ -n "$BUCKET" ] && [ -n "$DISTRIBUTION" ] || { echo "AprabotSite isn't deployed in this account" >&2; exit 1; }

SHA=$(git -C "$HOMEPAGE" rev-parse --short "$REF")
OUT=$(mktemp -d); trap 'rm -rf "$OUT"' EXIT
git -C "$HOMEPAGE" archive "$REF" | tar -x -C "$OUT"
rm -rf "$OUT"/lambda "$OUT"/scripts "$OUT"/CNAME "$OUT"/.gitkeep "$OUT"/.github "$OUT"/*.md
find "$OUT" -name .DS_Store -delete

if [ "$STAGE" != prod ]; then
  # The site is written against prod's backend; point it at this stage's.
  PROD_API=$(val prod apiId); API=$(api_id)
  [ -n "$API" ] || { echo "No aprabot-forecast API in this account" >&2; exit 1; }
  FROM=("$PROD_API" "$(val prod userPoolId)" "$(val prod userPoolClientId)")
  TO=("$API" "$(val "$STAGE" userPoolId)" "$(val "$STAGE" userPoolClientId)")
  for i in 0 1 2; do
    grep -rlF "${FROM[$i]}" "$OUT" | while IFS= read -r f; do
      FROM_S="${FROM[$i]}" TO_S="${TO[$i]}" perl -pi -e 's/\Q$ENV{FROM_S}\E/$ENV{TO_S}/g' "$f"; done
  done
  for i in 0 1 2; do
    if grep -rqF "${FROM[$i]}" "$OUT"; then echo "A prod backend ID is still in the $STAGE build" >&2; exit 1; fi
  done
  LABEL=$(echo "$STAGE" | perl -pe 's/^./\U$&/')
  cat > "$OUT/stage-badge.js" <<JS
(function () {
  var b = document.createElement('a');
  b.href = 'https://aprabot.com' + location.pathname;
  b.textContent = '$LABEL · $SHA';
  b.title = 'You are on $STAGE, with its own backend and data. Open this page on aprabot.com';
  b.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483000;padding:5px 10px;border-radius:999px;' +
    'background:#C8F24E;color:#0A0E15;font:600 12px/1.2 system-ui,sans-serif;text-decoration:none;box-shadow:0 4px 14px rgba(0,0,0,.25)';
  (document.body ? Promise.resolve() : new Promise(function (r) { addEventListener('DOMContentLoaded', r); }))
    .then(function () { document.body.appendChild(b); });
})();
JS
  printf 'User-agent: *\nDisallow: /\n' > "$OUT/robots.txt"
  find "$OUT" -name '*.html' -print0 | while IFS= read -r -d '' f; do
    perl -0pi -e 's#<head>#<head>\n<meta name="robots" content="noindex, nofollow">#i; s#</body>#<script src="/stage-badge.js"></script>\n</body>#i' "$f"
  done
fi

# HTML is checked on every visit; everything else is cached and cleared by
# the invalidation below.
aws s3 sync "$OUT" "s3://$BUCKET" --delete --exclude '*.html' --cache-control 'public, max-age=86400' --only-show-errors
aws s3 sync "$OUT" "s3://$BUCKET" --delete --exclude '*' --include '*.html' --cache-control 'no-cache' \
  --content-type 'text/html; charset=utf-8' --only-show-errors
aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION" --paths '/*' --query 'Invalidation.Id' --output text >/dev/null
echo "$STAGE site now serves homepage $SHA (https://$(out DistributionDomain))"
