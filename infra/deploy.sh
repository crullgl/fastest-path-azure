#!/usr/bin/env bash
# Fastest Path · Azure hackathon demo. Run from Azure Cloud Shell (Bash):
#   bash infra/deploy.sh you@example.com
# Creates everything in one resource group (rg-fastestpath). Safe to re-run.
# All data is synthetic. Nothing here connects to any VA system.
set -uo pipefail
INBOX="${1:?usage: bash infra/deploy.sh <demo inbox email>}"
LOC="${LOC:-eastus}"; SWA_LOC="${SWA_LOC:-eastus2}"; RG="${RG:-rg-fastestpath}"
ESC_SECONDS="${ESC_SECONDS:-180}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUB=$(az account show --query id -o tsv)
SUF=$(echo -n "$SUB$RG" | md5sum | cut -c1-6)
SQL="fp-sql-$SUF"; DB="fastestpath"; MAPS="fp-maps-$SUF"; AOAI="fp-aoai-$SUF"; ACS="fp-acs-$SUF"; EMAIL="fp-email-$SUF"
KV="fp-kv-$SUF"; ST="fpst$SUF"; FUNC="fp-api-$SUF"; APPI="fp-insights-$SUF"; LAW="fp-logs-$SUF"; SWA="fp-web-$SUF"
STATE="$HOME/.fastestpath.env"; touch "$STATE"; source "$STATE"
save(){ grep -v "^$1=" "$STATE" > "$STATE.tmp" 2>/dev/null; echo "$1='$2'" >> "$STATE.tmp"; mv "$STATE.tmp" "$STATE"; }
step(){ echo; echo "=== $* ==="; }
ok(){ echo "  ✓ $*"; }
warn(){ echo "  ! $*"; }
az config set extension.use_dynamic_install=yes_without_prompt extension.dynamic_install_allow_preview=true >/dev/null 2>&1

step "1/12 Register resource providers"
for p in Microsoft.Sql Microsoft.Maps Microsoft.CognitiveServices Microsoft.Communication Microsoft.Web Microsoft.Storage Microsoft.KeyVault Microsoft.Insights Microsoft.OperationalInsights Microsoft.AlertsManagement Microsoft.Consumption; do
  az provider register -n $p >/dev/null 2>&1 &
done; wait
for p in Microsoft.Sql Microsoft.Maps Microsoft.CognitiveServices Microsoft.Communication Microsoft.Web Microsoft.Storage Microsoft.KeyVault Microsoft.Insights Microsoft.OperationalInsights; do
  for i in $(seq 1 ${PROV_WAIT:-40}); do [ "$(az provider show -n $p --query registrationState -o tsv)" = "Registered" ] && break; sleep 6; done
  ok "$p $(az provider show -n $p --query registrationState -o tsv)"
done

step "2/12 Resource group $RG ($LOC)"
# A lab-provided resource group is used as is: its tags and location belong to whoever created it.
if az group show -n $RG -o none 2>/dev/null; then ok "using existing $RG (tags left unchanged)"; else az group create -n $RG -l $LOC --tags project=fastest-path purpose=hackathon-demo data=synthetic -o none && ok "$RG"; fi

step "3/12 Monitoring: Log Analytics + Application Insights"
az monitor log-analytics workspace create -g $RG -n $LAW -l $LOC -o none 2>/dev/null || true
az monitor app-insights component create -g $RG -a $APPI -l $LOC --workspace $LAW --kind web --application-type web -o none 2>/dev/null || true
APPI_CONN=$(az monitor app-insights component show -g $RG -a $APPI --query connectionString -o tsv 2>/dev/null)
[ -n "$APPI_CONN" ] && ok "Application Insights $APPI" || warn "Application Insights not created"

step "4/12 Storage for Functions"
az storage account create -g $RG -n $ST -l $LOC --sku Standard_LRS --allow-blob-public-access false --min-tls-version TLS1_2 -o none && ok "$ST"

step "5/12 Azure SQL (serverless, free offer)"
if [ -z "${SQLPW:-}" ]; then SQLPW="Fp$(openssl rand -hex 10)!aZ9"; save SQLPW "$SQLPW"; fi
# Some regions refuse new SQL servers on newer subscriptions; try several until one accepts.
if [ -n "${SQLNAME:-}" ] && az sql server show -g $RG -n $SQLNAME -o none 2>/dev/null; then SQL=$SQLNAME; else
  for L in $LOC centralus westus2 westus3 southcentralus northcentralus eastus2; do
    CAND="fp-sql-$L-$SUF"
    if az sql server create -g $RG -n $CAND -l $L -u fpadmin -p "$SQLPW" --minimal-tls-version 1.2 -o none 2>/dev/null; then SQL=$CAND; save SQLNAME "$SQL"; ok "SQL server in $L"; break; fi
    warn "$L not accepting new SQL servers"
  done
fi
az sql server firewall-rule create -g $RG -s $SQL -n AllowAzureServices --start-ip-address 0.0.0.0 --end-ip-address 0.0.0.0 -o none 2>/dev/null || true
if ! az sql db show -g $RG -s $SQL -n $DB -o none 2>/dev/null; then
  az sql db create -g $RG -s $SQL -n $DB -e GeneralPurpose -f Gen5 -c 2 --compute-model Serverless --auto-pause-delay 60 \
    --use-free-limit true --free-limit-exhaustion-behavior AutoPause --backup-storage-redundancy Local -o none \
  && ok "free serverless database" \
  || { warn "free offer unavailable, using Basic tier (~\$5/month)"; az sql db create -g $RG -s $SQL -n $DB -e Basic -o none; }
fi
ok "$SQL.database.windows.net / $DB"

step "6/12 Azure Maps"
az maps account create -g $RG -n $MAPS --sku G2 --kind Gen2 --accept-tos -o none 2>/dev/null || true
MAPS_KEY=$(az maps account keys list -g $RG -n $MAPS --query primaryKey -o tsv 2>/dev/null)
[ -n "$MAPS_KEY" ] && ok "$MAPS" || warn "Azure Maps not available; drive times will be estimates"

step "7/12 Azure OpenAI"
az cognitiveservices account create -g $RG -n $AOAI -l $LOC --kind OpenAI --sku S0 --custom-domain $AOAI --yes -o none 2>/dev/null || true
AOAI_ENDPOINT=$(az cognitiveservices account show -g $RG -n $AOAI --query properties.endpoint -o tsv 2>/dev/null)
AOAI_KEY=$(az cognitiveservices account keys list -g $RG -n $AOAI --query key1 -o tsv 2>/dev/null)
AOAI_DEP=""
if [ -n "$AOAI_KEY" ]; then
  for spec in "gpt-4.1-mini 2025-04-14 GlobalStandard" "gpt-4o-mini 2024-07-18 GlobalStandard" "gpt-4o-mini 2024-07-18 Standard" "gpt-35-turbo 0125 Standard"; do
    set -- $spec
    if az cognitiveservices account deployment show -g $RG -n $AOAI --deployment-name chat -o none 2>/dev/null; then AOAI_DEP=chat; break; fi
    az cognitiveservices account deployment create -g $RG -n $AOAI --deployment-name chat --model-name $1 --model-version $2 --model-format OpenAI --sku-name $3 --sku-capacity 20 -o none 2>/dev/null && { AOAI_DEP=chat; ok "model $1 ($3)"; break; }
  done
fi
[ -n "$AOAI_DEP" ] && ok "$AOAI" || warn "Azure OpenAI unavailable in this subscription; app uses template text"

step "8/12 Communication Services email"
az communication create -g $RG -n $ACS --location global --data-location UnitedStates -o none 2>/dev/null || true
az communication email create -g $RG -n $EMAIL --location global --data-location UnitedStates -o none 2>/dev/null || true
az communication email domain create -g $RG --email-service-name $EMAIL --domain-name AzureManagedDomain --location global --domain-management AzureManaged -o none 2>/dev/null || true
DOMAIN_ID=$(az communication email domain show -g $RG --email-service-name $EMAIL --domain-name AzureManagedDomain --query id -o tsv 2>/dev/null)
MAILFROM=$(az communication email domain show -g $RG --email-service-name $EMAIL --domain-name AzureManagedDomain --query mailFromSenderDomain -o tsv 2>/dev/null)
[ -n "$DOMAIN_ID" ] && az communication update -g $RG -n $ACS --linked-domains "$DOMAIN_ID" -o none 2>/dev/null
ACS_CONN=$(az communication list-key -g $RG -n $ACS --query primaryConnectionString -o tsv 2>/dev/null)
ACS_SENDER=""; [ -n "$MAILFROM" ] && ACS_SENDER="DoNotReply@$MAILFROM"
[ -n "$ACS_CONN" ] && [ -n "$ACS_SENDER" ] && ok "sender $ACS_SENDER" || warn "email not fully configured"

step "9/12 Key Vault (secrets out of code)"
az keyvault create -g $RG -n $KV -l $LOC --enable-rbac-authorization true -o none 2>/dev/null || true
KV_ID=$(az keyvault show -g $RG -n $KV --query id -o tsv)
ME=$(az ad signed-in-user show --query id -o tsv)
az role assignment create --assignee-object-id $ME --assignee-principal-type User --role "Key Vault Secrets Officer" --scope $KV_ID -o none 2>/dev/null || true
for i in $(seq 1 20); do az keyvault secret set --vault-name $KV -n probe --value ok -o none 2>/dev/null && break; sleep 10; done
az keyvault secret set --vault-name $KV -n sql-password --value "$SQLPW" -o none
[ -n "$MAPS_KEY" ] && az keyvault secret set --vault-name $KV -n maps-key --value "$MAPS_KEY" -o none
[ -n "$AOAI_KEY" ] && az keyvault secret set --vault-name $KV -n aoai-key --value "$AOAI_KEY" -o none
[ -n "$ACS_CONN" ] && az keyvault secret set --vault-name $KV -n acs-connection --value "$ACS_CONN" -o none
ok "$KV"

step "10/12 Azure Functions API"
if ! az functionapp show -g $RG -n $FUNC -o none 2>/dev/null; then
  az functionapp create -g $RG -n $FUNC --storage-account $ST --consumption-plan-location $LOC --os-type Linux --runtime node --runtime-version 22 \
    --functions-version 4 ${APPI_CONN:+--app-insights $APPI} -o none \
  || az functionapp create -g $RG -n $FUNC --storage-account $ST --flexconsumption-location $LOC --runtime node --runtime-version 22 ${APPI_CONN:+--app-insights $APPI} -o none
fi
FUNC_ID=$(az functionapp show -g $RG -n $FUNC --query id -o tsv)
PID=$(az functionapp identity assign -g $RG -n $FUNC --query principalId -o tsv)
az role assignment create --assignee-object-id $PID --assignee-principal-type ServicePrincipal --role "Key Vault Secrets User" --scope $KV_ID -o none 2>/dev/null || true
kvref(){ echo "@Microsoft.KeyVault(VaultName=$KV;SecretName=$1)"; }
SWA_HOST=$(az staticwebapp show -g $RG -n $SWA --query defaultHostname -o tsv 2>/dev/null)
SETTINGS=(SQL_SERVER=$SQL.database.windows.net SQL_DB=$DB SQL_USER=fpadmin "SQL_PASSWORD=$(kvref sql-password)" DEMO_INBOX=$INBOX ESCALATE_AFTER_SECONDS=$ESC_SECONDS ADMIN_EMAILS=${ADMIN_EMAILS:-$INBOX})
[ -n "$MAPS_KEY" ] && SETTINGS+=("MAPS_KEY=$(kvref maps-key)")
[ -n "$AOAI_DEP" ] && SETTINGS+=(AOAI_ENDPOINT=$AOAI_ENDPOINT "AOAI_KEY=$(kvref aoai-key)" AOAI_DEPLOYMENT=$AOAI_DEP)
[ -n "$ACS_CONN" ] && SETTINGS+=("ACS_CONNECTION=$(kvref acs-connection)" ACS_SENDER=$ACS_SENDER)
[ -n "$SWA_HOST" ] && SETTINGS+=(PUBLIC_URL=https://$SWA_HOST)
az functionapp config appsettings set -g $RG -n $FUNC --settings "${SETTINGS[@]}" -o none && ok "settings (secrets via Key Vault references)"
( cd "$ROOT/api" && rm -rf node_modules api.zip && npm install --omit=dev --no-audit --no-fund --loglevel=error && zip -qr ../api.zip . -x "*.zip" )
for i in 1 2 3; do az functionapp deployment source config-zip -g $RG -n $FUNC --src "$ROOT/api.zip" -o none 2>/dev/null && { ok "API deployed"; break; }; warn "deploy retry $i"; sleep 20; done

step "11/12 Static Web App (front end + Microsoft sign-in)"
az staticwebapp create -g $RG -n $SWA -l $SWA_LOC --sku Standard -o none 2>/dev/null || true
SWA_HOST=$(az staticwebapp show -g $RG -n $SWA --query defaultHostname -o tsv)
az functionapp config appsettings set -g $RG -n $FUNC --settings PUBLIC_URL=https://$SWA_HOST -o none
echo "  warming API and seeding Azure SQL (first call can take ~60s while the database resumes)..."
for i in $(seq 1 8); do
  H=$(curl -s -m 120 "https://$FUNC.azurewebsites.net/api/health"); echo "$H" | grep -q '"sql":true' && { ok "API healthy: $H"; break; }; sleep 15
done
az staticwebapp backends link -n $SWA -g $RG --backend-resource-id $FUNC_ID --backend-region $LOC -o none 2>/dev/null && ok "API linked behind the Static Web App" || warn "backend link failed (may already be linked)"
TOKEN=$(az staticwebapp secrets list -g $RG -n $SWA --query properties.apiKey -o tsv)
( cd "$ROOT" && npx -y @azure/static-web-apps-cli@latest deploy ./web --deployment-token "$TOKEN" --env production 2>&1 | tail -4 )

step "12/12 Budget alert (\$150, emails $INBOX)"
START=$(date -u +%Y-%m-01)
az rest --method put --url "https://management.azure.com/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.Consumption/budgets/fastestpath-budget?api-version=2023-05-01" --body "{
  \"properties\":{\"category\":\"Cost\",\"amount\":150,\"timeGrain\":\"Monthly\",\"timePeriod\":{\"startDate\":\"${START}T00:00:00Z\"},
  \"notifications\":{\"a50\":{\"enabled\":true,\"operator\":\"GreaterThan\",\"threshold\":50,\"contactEmails\":[\"$INBOX\"]},
  \"a80\":{\"enabled\":true,\"operator\":\"GreaterThan\",\"threshold\":80,\"contactEmails\":[\"$INBOX\"]}}}}" -o none 2>/dev/null && ok "budget set" || warn "budgets not supported on this subscription type"

echo; echo "================ DONE ================"
echo "Scheduler:  https://$SWA_HOST/"
echo "Supervisor: https://$SWA_HOST/supervisor.html"
echo "API:        $FUNC (linked behind the Static Web App)"
echo "Escalation: 3 demo days = $ESC_SECONDS seconds"
echo "Cleanup:    az group delete -n $RG --yes"
save SWA_HOST "$SWA_HOST"
