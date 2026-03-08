# IT Utilitaire — Installation sur Windows Server

## Prérequis

- Windows Server 2019/2022
- IIS activé avec le module **URL Rewrite** et **iisnode**
- **Node.js** ≥ 18 (LTS)
- **Git**
- Accès réseau vers `graph.microsoft.com` et `api.securitycenter.microsoft.com`

---

## 1. Installation des prérequis

### Node.js
```powershell
winget install OpenJS.NodeJS.LTS
```

### Git
```powershell
winget install Git.Git
```

### IIS + URL Rewrite
```powershell
# Activer IIS
Install-WindowsFeature -Name Web-Server, Web-Asp-Net45 -IncludeManagementTools

# URL Rewrite (télécharger et installer le MSI)
# https://www.iis.net/downloads/microsoft/url-rewrite
```

### iisnode
```
# Télécharger et installer depuis :
# https://github.com/Azure/iisnode/releases
# → iisnode-full-v0.2.26-x64.msi (ou version plus récente)
```

---

## 2. Cloner le dépôt

```powershell
cd C:\inetpub
git clone https://github.com/<org>/<repo>.git ITUtilitaire
```

---

## 3. Configurer les variables d'environnement

Créer le fichier `C:\inetpub\ITUtilitaire\backend\.env` :

```env
# Azure AD / Microsoft Graph
TENANT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
CLIENT_SECRET=votre_secret_ici

# Microsoft Defender for Endpoint
MDE_TENANT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
MDE_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
MDE_CLIENT_SECRET=votre_secret_mde_ici

# Optionnel
PORT=3000
AUTOPATCH_GROUP_NAME=Nom du groupe Autopatch
```

> **Ne jamais committer ce fichier.** Il est dans `.gitignore`.

---

## 4. Installer les dépendances Node.js

```powershell
cd C:\inetpub\ITUtilitaire\backend
npm install --omit=dev
```

---

## 5. Configurer IIS

### Créer le site

1. Ouvrir **IIS Manager**
2. Clic droit sur **Sites** → **Add Website**
   - Site name : `ITUtilitaire`
   - Physical path : `C:\inetpub\ITUtilitaire\backend`
   - Port : `80` (ou `443` avec certificat)
3. **OK**

### Permissions sur le dossier

```powershell
$appPoolUser = "IIS AppPool\ITUtilitaire"
icacls "C:\inetpub\ITUtilitaire" /grant "${appPoolUser}:(OI)(CI)RX" /T
icacls "C:\inetpub\ITUtilitaire\backend\iisnode_logs" /grant "${appPoolUser}:(OI)(CI)F" /T
```

> Si le dossier `iisnode_logs` n'existe pas encore, le créer :
> ```powershell
> New-Item -ItemType Directory "C:\inetpub\ITUtilitaire\backend\iisnode_logs" -Force
> ```

### Vérifier que iisnode est chargé

Dans IIS Manager → sélectionner le serveur → **Modules** → vérifier la présence de `iisnode`.

---

## 6. Vérification

```powershell
# Tester le endpoint de santé
Invoke-WebRequest http://localhost/health
# Attendu : {"status":"ok"}
```

Ouvrir un navigateur sur le serveur : `http://localhost`

---

## 7. Mises à jour (déploiements suivants)

Depuis le poste de développement, utiliser le script `deploy.ps1` (non versionné) ou manuellement sur le serveur :

```powershell
cd C:\inetpub\ITUtilitaire
git pull
cd backend
npm install --omit=dev
# Dans IIS Manager : Stop puis Start du site "ITUtilitaire"
```

---

## Permissions Azure AD requises (App Registration)

L'app registration doit avoir les **Application permissions** suivantes (avec admin consent) :

| Permission | Usage |
|---|---|
| `DeviceManagementManagedDevices.Read.All` | Liste des appareils Intune |
| `User.Read.All` | Recherche d'utilisateurs |
| `Device.Read.All` | Appareils Azure AD |
| `Group.ReadWrite.All` | Gestion groupe Autopatch |
| `DeviceLocalCredential.Read.All` | Mots de passe LAPS |
| `BitlockerKey.Read.All` | Clés de récupération BitLocker |
| `WindowsDefenderATP` → `Machine.Read.All` | MDE — liste machines |
| `WindowsDefenderATP` → `Vulnerability.Read.All` | MDE — vulnérabilités |
| `WindowsDefenderATP` → `Software.Read.All` | MDE — logiciels installés |

Les permissions MDE (`WindowsDefenderATP`) se configurent séparément dans l'app registration → **API permissions** → **APIs my organization uses** → `WindowsDefenderATP`.
