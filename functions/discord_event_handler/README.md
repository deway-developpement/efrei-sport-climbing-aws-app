# Discord Event Handler Lambda

## 📋 Description

Cette fonction Lambda est le **point d'entrée principal** pour toutes les interactions Discord du bot ESC (Efrei Sport Climbing). Elle gère les commandes slash, les boutons, les menus de sélection et les modales.

## 🎯 Fonctionnalités

### Commandes Slash

| Commande | Description | Accès |
|----------|-------------|-------|
| `/inscription` | Inscription d'un utilisateur au système | Tous |
| `/séance` | Créer une nouvelle séance d'escalade | Membres |
| `/activité` | Consulter son nombre de participations sur une période | Membres |
| `/helloasso` | Obtenir son identifiant HelloAsso pour les commandes | Membres |
| `/relevé` | Générer un export CSV des participations | Admin |
| `/issues` | Lister les problèmes de commandes en cours | Admin |
| `/status` | Afficher le statut du système (tickets, commandes) | Admin |
| `/commande` | Afficher les détails d'une commande | Membres |

### Interactions Boutons

- **Rejoindre** : S'inscrire à une séance d'escalade
- **Se désinscrire** : Se retirer d'une séance
- **Voir détails commande** : Afficher les informations d'une commande HelloAsso
- **Annuler commande** : Annuler une commande problématique
- **Marquer comme traité** : Clôturer un issue
- **Voir tickets** : Afficher les tickets associés à une commande

### Menus de sélection

- Sélection de participants pour suppression (admin)
- Sélection de tickets à envoyer

### Modales

- Annulation de commande avec motif

## ⚙️ Variables d'environnement

| Variable | Description |
|----------|-------------|
| `DISCORD_APP_ID` | ID de l'application Discord |
| `PUBLIC_KEY` | Clé publique pour vérification des signatures Discord |
| `DISCORD_ROLE_ID` | ID du rôle membre |
| `DISCORD_ROLE_ADMIN_ID` | ID du rôle administrateur |
| `GUILD_ID` | ID du serveur Discord |
| `ANTREBLOC_CHANNEL` | ID du channel pour les séances Antrebloc |
| `CLIMBUP_CHANNEL` | ID du channel pour les séances Climb Up |
| `CLIMBUP_BORDEAUX_CHANNEL` | ID du channel pour les séances Climb Up Bordeaux |

## 🔗 Déclencheur

**API Gateway** : `POST /discord-event-handler`

Ce endpoint est configuré comme **Interactions Endpoint URL** dans la console développeur Discord.

## 🔒 Sécurité

- Vérification de signature Ed25519 pour toutes les requêtes entrantes
- Vérification des rôles pour les commandes admin
- Ping/Pong automatique pour la validation Discord

## 📦 Dépendances

- `tweetnacl` : Vérification des signatures
- `commons/dynamodb.*` : Accès aux tables DynamoDB (users, sessions, tickets, issues)
- `commons/discord.*` : Types et utilitaires Discord
- `commons/helloasso.*` : Intégration HelloAsso

## 📁 Structure

```
discord_event_handler/
├── app.ts                      # Point d'entrée Lambda
├── src/
│   ├── discord.handler.ts      # Logique de traitement des commandes/interactions
│   ├── discord.interaction.ts  # Utilitaires pour répondre aux interactions
│   ├── discord.utils.ts        # Fonctions utilitaires
│   └── s3.images.ts            # Accès S3
├── jest.config.ts
├── package.json
└── tsconfig.json
```

## 🔄 Flux de traitement

```
Requête Discord
      │
      ▼
Vérification signature ──► 401 si invalide
      │
      ▼
Ping/Pong ? ──► Réponse type 1
      │
      ▼
Vérification rôle
      │
      ├── ApplicationCommand ──► command_handler
      ├── Button ──► button_handler
      ├── SelectMenu ──► select_menu_handler
      └── ModalSubmit ──► modal_handler
```
