# HelloAsso Event Handler Lambda

## 📋 Description

Cette fonction Lambda gère les **webhooks HelloAsso** pour automatiser le traitement des commandes de tickets d'escalade. Elle valide les paiements, vérifie les identifiants Discord, attribue les tickets et envoie les PDF aux utilisateurs.

## 🎯 Fonctionnalités

### Traitement des paiements

1. **Réception du webhook** HelloAsso lors d'un paiement
2. **Validation du paiement** (état autorisé, formulaire correct)
3. **Vérification de la commande** via l'API HelloAsso
4. **Extraction des identifiants Discord** depuis les champs personnalisés
5. **Attribution des tickets** PDF depuis le stock S3
6. **Envoi des tickets** en message privé Discord aux acheteurs
7. **Mise à jour de la base de données** (commandes, tickets vendus)

### Gestion des erreurs

Création automatique d'**issues** dans les cas suivants :
- Erreur de récupération de commande HelloAsso
- Commande avec plus de 10 articles
- Identifiant Discord manquant ou invalide
- Stock de tickets insuffisant
- Utilisateur non trouvable sur le serveur Discord
- Échec d'envoi de message privé

### Alertes Discord

Envoi d'alertes dans un channel de log avec boutons d'action :
- Voir détails de la commande
- Annuler la commande
- Marquer comme traité
- Voir/récupérer les tickets

## ⚙️ Variables d'environnement

| Variable | Description |
|----------|-------------|
| `DISCORD_ROLE_ID` | ID du rôle membre |
| `GUILD_ID` | ID du serveur Discord |

## 🔗 Déclencheur

**API Gateway** : `POST /helloasso-event-handler`

Ce endpoint est configuré comme **webhook URL** dans l'espace organisateur HelloAsso.

## 🔒 Secrets

| Secret | Description |
|--------|-------------|
| `Efrei-Sport-Climbing-App/secrets/discord_bot_token` | Token du bot Discord |
| `Efrei-Sport-Climbing-App/secrets/helloasso_client_secret` | Credentials API HelloAsso |

## 📦 Dépendances

- `commons/helloasso.*` : Types et requêtes API HelloAsso
- `commons/dynamodb.tickets` : Gestion des tickets et commandes
- `commons/dynamodb.issues` : Gestion des problèmes
- `commons/discord.*` : Types et composants Discord

## 📤 Réponses

| Code | Description |
|------|-------------|
| `200` | Traitement réussi ou événement ignoré |
| `400` | Erreur de traitement (issue créée) |

## 📁 Structure

```
helloasso_event_handler/
├── app.ts                      # Point d'entrée Lambda
├── src/
│   ├── discord.interaction.ts  # Envoi de messages Discord
│   └── s3.tickets.ts           # Récupération des tickets PDF
├── jest.config.ts
├── package.json
└── tsconfig.json
```

## 🔄 Flux de traitement

```
Webhook HelloAsso (Payment)
           │
           ▼
Vérification état paiement ──► Ignoré si non autorisé
           │
           ▼
Vérification formulaire (climb-up/Shop)
           │
           ▼
Fetch commande API HelloAsso ──► Issue si erreur
           │
           ▼
Validation :
    ├── Moins de 10 items
    ├── Champ Discord ID présent
    └── Format ID Discord valide
           │
           ▼
Récupération tickets non vendus
           │
           ▼
Pour chaque utilisateur Discord :
    │
    ├── Vérification membre serveur
    ├── Récupération fichiers PDF depuis S3
    └── Envoi DM avec les tickets
           │
           ▼
Mise à jour BDD :
    ├── Création OrderRecord
    └── Marquage tickets comme vendus
```

## ⚠️ Cas particuliers

- **Commande déjà traitée** : Ignorée silencieusement
- **Issue existante** : Pas de double création
- **Utilisateur introuvable** : Issue créée, commande non annulée automatiquement
- **DM fermés** : Issue créée avec les tickets en attente
