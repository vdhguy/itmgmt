# ============================================
# deploy.ps1 - Deploiement vers le serveur
# Usage: .\deploy.ps1 -ServerPath "\\SERVEUR\MonParcIT"
# ============================================

param(
    [string]$ServerPath = "\\srv-ops\lasne",
    [string]$LocalPath  = "$PSScriptRoot\backend",
    [System.Management.Automation.PSCredential]$Credential = $null
)

# Demander les identifiants si non fournis
if ($null -eq $Credential) {
    $Credential = Get-Credential -Message "Identifiants pour le serveur srv-ops"
}

Write-Host "Deploiement en cours..." -ForegroundColor Cyan

# 1. Monter le partage reseau avec les identifiants
$driveLetter = "R"
$netUser     = $Credential.UserName
$netPassword = $Credential.GetNetworkCredential().Password

# Deconnecter si deja monte
net use "${driveLetter}:" /delete /y 2>$null | Out-Null

$netResult = net use "${driveLetter}:" $ServerPath $netPassword /user:$netUser /persistent:no 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Error "Impossible de se connecter a $ServerPath : $netResult"
    exit 1
}

# Verifier que le dossier partage est accessible
if (-not (Test-Path "${driveLetter}:")) {
    Write-Error "Impossible d'acceder a $ServerPath"
    net use "${driveLetter}:" /delete /y 2>$null | Out-Null
    exit 1
}

# 2. Copier les fichiers (exclut node_modules et .env)
Write-Host "Copie des fichiers..." -ForegroundColor Yellow
robocopy $LocalPath "${driveLetter}:" `
    /MIR `
    /XD "node_modules" ".git" "iisnode_logs" `
    /XF ".env" "*.log" `
    /NFL /NDL /NJH

if ($LASTEXITCODE -ge 8) {
    Write-Error "Erreur lors de la copie robocopy (code $LASTEXITCODE)"
    net use "${driveLetter}:" /delete /y 2>$null | Out-Null
    exit 1
}

Write-Host "Fichiers copiés avec succès." -ForegroundColor Green

# 3. Installer les dependances npm sur le serveur (via WinRM)
$winrmAvailable = $false
try {
    $testWinRM = Test-WSMan -ComputerName $env:COMPUTERNAME -ErrorAction Stop
    $winrmAvailable = $true
} catch {
    $winrmAvailable = $false
}

if ($winrmAvailable) {
    # Recuperer le chemin physique du partage sur le serveur
    $shareName = ($ServerPath -split '\\')[-1]
    $serverLocalPath = Invoke-Command -ComputerName srv-ops -Credential $Credential -ScriptBlock {
        param($share)
        (Get-SmbShare -Name $share -ErrorAction Stop).Path
    } -ArgumentList $shareName

    Write-Host "Chemin serveur : $serverLocalPath" -ForegroundColor Gray
    Write-Host "Installation des dependances npm sur le serveur..." -ForegroundColor Yellow
    Invoke-Command -ComputerName srv-ops -Credential $Credential -ScriptBlock {
        param($path)
        Set-Location $path
        npm install --omit=dev
    } -ArgumentList $serverLocalPath

    # 4. Redemarrer le site IIS
    Write-Host "Redemarrage IIS..." -ForegroundColor Yellow
    Invoke-Command -ComputerName srv-ops -Credential $Credential -ScriptBlock {
        Import-Module WebAdministration
        Stop-WebSite -Name "Lasne"
        Start-WebSite -Name "Lasne"
    }
    Write-Host "IIS redemarré." -ForegroundColor Green
} else {
    Write-Host "---------------------------------------------------" -ForegroundColor Yellow
    Write-Host "WinRM non disponible - etapes manuelles requises :" -ForegroundColor Yellow
    Write-Host "  1. Connecte-toi au serveur via RDP" -ForegroundColor Yellow
    Write-Host "  2. Ouvre un terminal dans C:\inetpub\MonParcIT" -ForegroundColor Yellow
    Write-Host "  3. Tape : npm install --omit=dev" -ForegroundColor Yellow
    Write-Host "  4. Dans IIS Manager : redemarrer le site MonParcIT" -ForegroundColor Yellow
    Write-Host "---------------------------------------------------" -ForegroundColor Yellow
}

net use "${driveLetter}:" /delete /y 2>$null | Out-Null
Write-Host "Deploiement termine !" -ForegroundColor Green