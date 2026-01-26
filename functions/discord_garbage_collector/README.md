# Discord Garbage Collector Lambda

## 📋 Description

Cette fonction Lambda effectue un **nettoyage automatique** des messages de séances expirées dans les channels Discord. Elle s'exécute quotidiennement pour maintenir les channels propres.

## 🎯 Fonctionnalités

- Récupère toutes les sessions expirées depuis DynamoDB
- Supprime les messages Discord correspondants dans les channels appropriés
- Marque les sessions comme expirées dans la base de données
- Gestion de la concurrence avec un pool de 5 requêtes simultanées max
- Système de retry (jusqu'à 3 tentatives) en cas d'échec

## ⚙️ Variables d'environnement

| Variable | Description |
|----------|-------------|
| `PUBLIC_KEY` | Clé publique Discord (non utilisée mais présente) |
| `ANTREBLOC_CHANNEL` | ID du channel pour les séances Antrebloc |
| `CLIMBUP_CHANNEL` | ID du channel pour les séances Climb Up |
| `CLIMBUP_BORDEAUX_CHANNEL` | ID du channel pour les séances Climb Up Bordeaux |

## 🔗 Déclencheur

**EventBridge Schedule** : `cron(0 0 * * ? *)`

Exécution quotidienne à **minuit UTC**.

## 🔒 Secrets

| Secret | Description |
|--------|-------------|
| `Efrei-Sport-Climbing-App/secrets/discord_bot_token` | Token du bot Discord pour l'API |

## 📦 Dépendances

- `commons/dynamodb.sessions` : Accès aux sessions (listSessionsExpired, expireSession)
- `commons/aws.secret` : Récupération des secrets

## 📤 Sortie

```json
{
  "statusCode": 200,
  "body": "{\"message\": \"ok !\"}"
}
```

## 📁 Structure

```
discord_garbage_collector/
├── app.ts              # Point d'entrée Lambda
├── jest.config.ts
├── package.json
└── tsconfig.json
```

## 🔄 Flux de traitement

```
Déclenchement planifié (minuit)
           │
           ▼
Récupération sessions expirées
           │
           ▼
Pour chaque session (max 5 en parallèle):
    │
    ├── DELETE message Discord
    │       │
    │       ├── Succès ──► expireSession()
    │       │
    │       └── Échec ──► Retry (max 3x)
    │
    └── Délai 500ms (rate limiting)
```

## ⚠️ Gestion des erreurs

- Les erreurs de suppression sont loguées mais n'interrompent pas le traitement
- Un système de retry permet de gérer les erreurs temporaires (rate limiting Discord)
- Après 3 échecs, la session est abandonnée pour cette exécution
