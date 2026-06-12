# Hotfix colores Centro Imputaciones AMS -> produccion
#
# CRITICO: produccion exige tests cuando hay Apex. Sin --test-level el CLI
# corre RunLocalTests (51 tests) y falla ApplyCaseAssignmentRulesTest
# (validation rule Case V11, ajeno a este modulo). Aqui forzamos
# RunSpecifiedTests con los 3 tests propios.

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..

$sources = @(
    "force-app/main/default/classes/ImputacionesOperativeConfigLoader.cls",
    "force-app/main/default/classes/ImputacionesAMSController.cls",
    "force-app/main/default/classes/ImputacionesAMSControllerTest.cls"
)

$tests = @(
    "ImputacionesAMSControllerTest",
    "CentroImputacionesConfigControllerTest",
    "ImputacionesBillableRulesTest"
)

$sourceArgs = $sources | ForEach-Object { "--source-dir"; $_ }
$testArgs = $tests | ForEach-Object { "--tests"; $_ }

Write-Host "Deploying hotfix de colores con RunSpecifiedTests..." -ForegroundColor Cyan
sf project deploy start `
    @sourceArgs `
    --target-org produccion `
    --test-level RunSpecifiedTests `
    @testArgs `
    --wait 60
