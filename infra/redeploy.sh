#!/usr/bin/env bash
# Push code changes to the existing deployment (API + web). Run from the repo root in Cloud Shell.
set -uo pipefail
RG="${RG:-rg-fastestpath}"; ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FUNC=$(az functionapp list -g $RG --query "[0].name" -o tsv); SWA=$(az staticwebapp list -g $RG --query "[0].name" -o tsv)
echo "API: $FUNC   Web: $SWA"
( cd "$ROOT/api" && rm -rf node_modules ../api.zip && npm install --omit=dev --no-audit --no-fund --loglevel=error && zip -qr ../api.zip . -x "*.zip" )
az functionapp deployment source config-zip -g $RG -n $FUNC --src "$ROOT/api.zip" -o none && echo "  ✓ API deployed"
TOKEN=$(az staticwebapp secrets list -g $RG -n $SWA --query properties.apiKey -o tsv)
( cd "$ROOT" && npx -y @azure/static-web-apps-cli@latest deploy ./web --deployment-token "$TOKEN" --env production 2>&1 | tail -2 )
echo "Done."
