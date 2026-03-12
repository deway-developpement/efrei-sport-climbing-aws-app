# Efrei Sport Climbing — AWS App (Serverless · SAM · TypeScript)

[![AWS SAM](https://img.shields.io/badge/AWS-SAM-orange?logo=amazon-aws)](https://aws.amazon.com/serverless/sam/)
[![Node.js](https://img.shields.io/badge/Node.js-22+-green?logo=node.js)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Discord](https://img.shields.io/badge/Discord-Bot-5865F2?logo=discord)](https://discord.com/)

Plateforme serverless pour automatiser les flux de l'association **Efrei Sport Climbing** (ESC) sur AWS. Cette application gère un bot Discord pour organiser les séances d'escalade, la vente de tickets via HelloAsso, et la distribution automatique de billets aux membres.

---

## 🎯 Objectifs

- **Bot Discord** : Gérer les inscriptions aux séances d'escalade, suivi des participations, commandes slash
- **Intégration HelloAsso** : Traitement automatique des paiements et distribution des tickets PDF
- **Gestion des tickets** : Inventaire automatisé des tickets Climb Up, attribution aux acheteurs
- **Calendrier partagé** : Génération d'un fichier iCal des séances à venir
- **Administration** : Relevés de participation, gestion des issues, statut du système

---

## 🗂️ Arborescence du repo

```
.
├─ events/                          # Exemples d'événements pour tests locaux
├─ functions/                       # Fonctions Lambda (TypeScript)
│   ├─ calendar_generator/          # Génération calendrier iCal
│   ├─ discord_event_handler/       # Handler principal Discord (commandes/boutons)
│   ├─ discord_garbage_collector/   # Nettoyage des messages expirés
│   ├─ helloasso_event_handler/     # Webhooks HelloAsso (paiements/tickets)
│   └─ tickets_registor/            # Inventaire S3 des tickets PDF
├─ layers/
│   └─ commons/                     # Code partagé (types/clients/utils)
├─ secrets/                         # Fichiers secrets (non versionnés)
├─ utils/                           # Scripts/outils de dev
├─ template.yaml                    # Template SAM (ressources & permissions)
├─ samconfig.toml                   # Paramètres de déploiement
└─ README.md
```

---

## ⚡ Fonctions Lambda

| Fonction | Déclencheur | Description |
|----------|-------------|-------------|
| **[discord_event_handler](functions/discord_event_handler/)** | API Gateway | Gère toutes les interactions Discord (commandes, boutons, menus, modales) |
| **[helloasso_event_handler](functions/helloasso_event_handler/)** | API Gateway | Traite les webhooks HelloAsso et distribue les tickets aux acheteurs |
| **[discord_garbage_collector](functions/discord_garbage_collector/)** | EventBridge (cron) | Nettoie automatiquement les messages de séances expirées |
| **[tickets_registor](functions/tickets_registor/)** | S3 Events | Gère l'inventaire des tickets PDF (ajout/suppression) |
| **[calendar_generator (Unused)](functions/calendar_generator/)** | Manuel/Scheduler | Génère un calendrier iCal des séances |

---

## 🤖 Commandes Discord

| Commande | Description | Accès |
|----------|-------------|-------|
| \`/inscription\` | S'inscrire au système ESC | Tous |
| \`/séance\` | Créer une nouvelle séance d'escalade | Membres |
| \`/activité\` | Consulter son nombre de participations | Membres |
| \`/helloasso\` | Obtenir son identifiant pour les commandes HelloAsso | Membres |
| \`/commande\` | Afficher les détails d'une commande | Membres |
| \`/relevé\` | Générer un export CSV des participations | Admin |
| \`/issues\` | Lister les problèmes de commandes en cours | Admin |
| \`/status\` | Afficher le statut du système (tickets, commandes) | Admin |

---

## 🧱 Architecture

```
┌─────────────────┐     ┌─────────────────┐
│    Discord      │     │   HelloAsso     │
│  (Interactions) │     │   (Webhooks)    │
└────────┬────────┘     └────────┬────────┘
         │                       │
         ▼                       ▼
┌─────────────────────────────────────────┐
│            API Gateway (REST)           │
│  /discord-event-handler                 │
│  /helloasso-event-handler               │
└─────────────────────────────────────────┘
                    │
         ┌──────────┼──────────┐
         ▼          ▼          ▼
┌─────────────┐ ┌─────────┐ ┌─────────────┐
│   Lambda    │ │ Lambda  │ │   Lambda    │
│  Discord    │ │HelloAsso│ │  Garbage    │
│  Handler    │ │ Handler │ │ Collector   │
└──────┬──────┘ └────┬────┘ └──────┬──────┘
       │             │             │
       └─────────────┼─────────────┘
                     ▼
       ┌─────────────────────────────┐
       │      Layer Commons          │
       │  (Types, Clients, Utils)    │
       └─────────────────────────────┘
                     │
    ┌────────────────┼────────────────┐
    ▼                ▼                ▼
┌──────────┐    ┌───────────┐    ┌───────────┐
│ DynamoDB │    │    S3     │    │  Secrets  │
│          │    │           │    │  Manager  │
│• users   │    │• tickets/ │    │           │
│• sessions│    │• calendar │    │• discord  │
│• tickets │    │           │    │• helloasso│
│• issues  │    │           │    │           │
└──────────┘    └───────────┘    └───────────┘
```

### Tables DynamoDB

| Table | Description |
|-------|-------------|
| \`Efrei-Sport-Climbing-App.users\` | Utilisateurs inscrits (id Discord, prénom, nom, promo) |
| \`Efrei-Sport-Climbing-App.sessions\` | Séances d'escalade (date, lieu, participants) |
| \`Efrei-Sport-Climbing-App.tickets\` | Inventaire des tickets PDF (url, vendu, commande) |
| \`Efrei-Sport-Climbing-App.issues\` | Problèmes de commandes à traiter |

### Bucket S3

- \`efrei-sport-climbing-app-test-data-v2/...\` : Bucket utilise par l'environnement \`test\`
- \`efrei-sport-climbing-app-data/...\` : Bucket utilise par l'environnement \`prod\`
- \`tickets/climb-up/\` : Tickets PDF Climb Up
- \`ressources/calendar.ics\` : Calendrier iCal

---

## 🔄 Flux métier

### Achat de tickets (HelloAsso → Discord)

```
1. Utilisateur achète sur HelloAsso (avec son ID Discord)
         │
         ▼
2. Webhook déclenche helloasso_event_handler
         │
         ▼
3. Validation : paiement OK, ID Discord valide, stock suffisant
         │
    ┌────┴────┐
    ▼         ▼
 Succès    Échec
    │         │
    ▼         ▼
4a. Récup    4b. Création
tickets S3   issue + alerte
    │         admin
    ▼
5. Envoi DM Discord avec PDF
    │
    ▼
6. Marquage tickets comme vendus
```

### Organisation d'une séance

```
1. Membre : /séance [jour] [heure] [lieu]
         │
         ▼
2. Message embed posté dans le channel
   avec boutons "Rejoindre" / "Se désinscrire"
         │
         ▼
3. Membres cliquent pour s'inscrire
         │
         ▼
4. Liste des participants mise à jour en temps réel
         │
         ▼
5. À minuit (J+1) : garbage_collector supprime le message
```

---

## 🛠️ Prérequis

- **Node.js 22+**
- **Docker** (pour \`sam local\`)
- **AWS CLI** configuré (profil avec droits CloudFormation/IAM/Lambda/etc.)
- **AWS SAM CLI** installé

---

## ▶️ Développement local

### Build

```bash
sam build
```

### Lancer l'API locale

```bash
sam local start-api
# L'API écoute par défaut sur http://127.0.0.1:3000
```

### Invoquer une fonction avec un event

```bash
# Discord event handler
sam local invoke DiscordEventHandlerFunction --event events/event_ping.json

# HelloAsso event handler
sam local invoke HelloAssoEventHandlerFunction --event events/event_helloasso.json

# Tickets registor (S3 event)
sam local invoke TicketsRegistorFunction --event events/event_s3_tickets.json
```

### Consulter les logs

```bash
sam logs -n DiscordEventHandlerFunction --stack-name efrei-sport-climbing-aws-app --tail
```

## 🔎 Indexation Algolia

Une première intégration Algolia est prévue pour les utilisateurs via `functions/algolia_users_indexer/`.

- Le stream DynamoDB de `Efrei-Sport-Climbing-App.users` alimente l'index Algolia `esc_users`
- Le secret `Efrei-Sport-Climbing-App/secrets/algolia` doit contenir `ALGOLIA_APP_ID` et `ALGOLIA_ADMIN_API_KEY`
- Initialiser l'environnement Python local avec Poetry en utilisant l'interpréteur géré par `pyenv` : `poetry env use "$(pyenv which python)" && poetry install --no-root`
- Pour indexer les données existantes, exécuter `poetry run python utils/backfill_algolia_users.py` avec `ALGOLIA_SECRET_PATH` et `ALGOLIA_USERS_INDEX`

---

## ☁️ Déploiement

### Première fois (guidé)

```bash
sam deploy --guided
```

### Déploiements suivants

```bash
sam build && sam deploy
```

### Endpoints déployés

| Endpoint | URL |
|----------|-----|
| Discord | \`https://<api-id>.execute-api.<region>.amazonaws.com/Prod/discord-event-handler/\` |
| HelloAsso | \`https://<api-id>.execute-api.<region>.amazonaws.com/Prod/helloasso-event-handler/\` |

---

## 🔐 Configuration des secrets

Les secrets sont stockés dans **AWS Secrets Manager** :

| Secret | Contenu |
|--------|---------|
| \`Efrei-Sport-Climbing-App/secrets/discord_bot_token\` | \`DISCORD_BOT_TOKEN\` |
| \`Efrei-Sport-Climbing-App/secrets/helloasso_client_secret\` | \`HELLO_ASSO_CLIENT_ID\`, \`HELLO_ASSO_CLIENT_SECRET\` |

### Mise à jour d'un secret

```bash
aws secretsmanager put-secret-value \
  --secret-id Efrei-Sport-Climbing-App/secrets/discord_bot_token \
  --secret-string '{"DISCORD_BOT_TOKEN":"votre-token"}'
```

---

## 🧪 Tests

Chaque fonction Lambda dispose de tests Jest :

```bash
cd functions/discord_event_handler
npm install
npm test
```

### Fichiers d'événements de test

Le dossier \`events/\` contient des exemples d'événements pour les tests locaux :

| Fichier | Description |
|---------|-------------|
| \`event_ping.json\` | Ping Discord (validation endpoint) |
| \`event_séance.json\` | Commande /séance |
| \`event_inscription.json\` | Commande /inscription |
| \`event_helloasso.json\` | Webhook paiement HelloAsso |
| \`event_s3_tickets.json\` | Événement S3 (ajout ticket) |

---

## 🚦 Quality Gates

- **CI** : \`sam build\` + \`npm test\` + \`eslint --max-warnings=0\`
- **IaC** : *cfn-nag* / *cfn-guard* sur \`template.yaml\`
- **Sécu** : Pas de secrets en clair, uniquement **Secrets Manager**

---

## 🧹 Nettoyage (⚠️ destructif)

```bash
aws cloudformation delete-stack --stack-name efrei-sport-climbing-aws-app
```

> ⚠️ Le bucket S3 a une politique de rétention \`Retain\` et doit être supprimé manuellement.

---

## 🤝 Contribuer

1. Branche \`feature/<nom>\`
2. Commits atomiques (message clair)
3. PR décrivant contexte, tests, impacts infra
4. Review obligatoire avant merge \`master\`

---

## 📄 Licence

MIT
