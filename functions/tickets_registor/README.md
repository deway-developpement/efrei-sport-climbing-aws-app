# Tickets Registor Lambda

## 📋 Description

Cette fonction Lambda gère l'**inventaire automatique des tickets** PDF stockés sur S3. Elle se déclenche automatiquement lors de l'ajout ou la suppression de fichiers PDF dans le bucket S3.

## 🎯 Fonctionnalités

### Ajout de ticket

Lorsqu'un fichier PDF est uploadé dans `tickets/climb-up/` :
1. Récupère les métadonnées de l'objet S3
2. Crée un enregistrement dans DynamoDB avec :
   - ID unique (AWS Request ID)
   - URL du fichier (clé S3)
   - Statut : non vendu (`sold: false`)
   - Date d'ajout

### Suppression de ticket

Lorsqu'un fichier PDF est supprimé de `tickets/climb-up/` :
1. Recherche le ticket correspondant par URL
2. Supprime l'enregistrement de la base de données

## ⚙️ Configuration

| Variable | Description |
|----------|-------------|
| `S3_BUCKET_NAME` | Nom du bucket S3 cible. `efrei-sport-climbing-app-test-data-v2` en `test`, `efrei-sport-climbing-app-data` en `prod` |

## 🔗 Déclencheur

**S3 Event Notification** sur le bucket configure via `S3_BUCKET_NAME` :

| Événement | Filtre |
|-----------|--------|
| `s3:ObjectCreated:*` | `tickets/climb-up/*.pdf` |
| `s3:ObjectRemoved:*` | `tickets/climb-up/*.pdf` |

## 📦 Dépendances

- `commons/dynamodb.tickets` : Gestion des tickets (putTicket, deleteTicketByUrl)

## 📤 Réponses

| Code | Message | Description |
|------|---------|-------------|
| `200` | `file added to db` | Ticket(s) enregistré(s) avec succès |
| `400` | `no records` | Événement sans enregistrements S3 |
| `400` | `no s3` | Données S3 manquantes |
| `400` | `no object` | Objet S3 manquant |

## 📁 Structure

```
tickets_registor/
├── app.ts              # Point d'entrée Lambda
├── src/
│   └── s3.images.ts    # Utilitaires S3 (non utilisé ici)
├── jest.config.ts
├── package.json
└── tsconfig.json
```

## 🔄 Flux de traitement

```
Événement S3 (ObjectCreated / ObjectRemoved)
           │
           ▼
Extraction des Records
           │
           ▼
Pour chaque Record :
    │
    ├── ObjectCreated:* ──► putTicket()
    │       │
    │       └── Crée enregistrement :
    │           - id: awsRequestId
    │           - url: object.key
    │           - sold: false
    │           - date: now
    │
    └── ObjectRemoved:* ──► deleteTicketByUrl()
```

## 💡 Utilisation

### Ajouter des tickets au stock

```bash
# Upload un ticket PDF
aws s3 cp ticket.pdf s3://efrei-sport-climbing-app-test-data-v2/tickets/climb-up/ticket-001.pdf
```

### Retirer un ticket du stock

```bash
# Supprimer un ticket
aws s3 rm s3://efrei-sport-climbing-app-test-data-v2/tickets/climb-up/ticket-001.pdf
```

## ⚠️ Notes importantes

- Seuls les fichiers `.pdf` dans `tickets/climb-up/` déclenchent la fonction
- L'ID du ticket utilise l'AWS Request ID pour garantir l'unicité
- Les erreurs de suppression sont loguées mais ne font pas échouer l'exécution
