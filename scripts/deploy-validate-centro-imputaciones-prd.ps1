# Validate + quick deploy � Centro Imputaciones AMS (produccion)
#
# NO usar --test-level RunLocalTests: ejecuta ~30 tests del org y falla
# ApplyCaseAssignmentRulesTest (validation rule Case V11, no relacionado con este deploy).
#
# Solo estos 3 tests (RunSpecifiedTests):

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..

$tests = @(
    "ImputacionesAMSControllerTest",
    "CentroImputacionesConfigControllerTest",
    "ImputacionesBillableRulesTest"
)

$testArgs = $tests | ForEach-Object { "--tests"; $_ }

Write-Host "Validating manifest/package_centroImputacionesAMS.xml (RunSpecifiedTests only)..." -ForegroundColor Cyan
sf project deploy validate `
    --manifest manifest/package_centroImputacionesAMS.xml `
    --test-level RunSpecifiedTests `
    @testArgs `
    --target-org produccion `
    --wait 60

Write-Host ""
Write-Host "Hotfix rapido (LWC+Apex sin validate completo):" -ForegroundColor Yellow
Write-Host "  scripts/deploy-hotfix-colores-prd.ps1"
Write-Host ""
Write-Host "Si el validate termino OK, copia el Deploy ID y ejecuta:" -ForegroundColor Green
Write-Host "  sf project deploy quick --job-id <DEPLOY_ID> --target-org produccion --wait 30"
