# Calendar Generator Lambda (Deprecated/Unused)

## 📋 Description

Cette fonction Lambda génère un fichier calendrier au format **iCalendar (.ics)** contenant toutes les séances d'escalade non expirées de l'association.

## 🎯 Fonctionnalités

- Récupère les sessions d'escalade non expirées depuis DynamoDB
- Génère un fichier `.ics` compatible avec les applications de calendrier (Google Calendar, Apple Calendar, Outlook, etc.)
- Inclut pour chaque séance :
  - Date et heure de début
  - Durée de 2 heures
  - Lieu de la séance
  - Liste des participants
- Upload le fichier généré sur S3 (`ressources/calendar.ics`)

## ⚙️ Configuration

| Variable | Description |
|----------|-------------|
| - | Cette fonction n'a pas de variables d'environnement spécifiques |

## 🔗 Déclencheur

Cette fonction peut être invoquée manuellement ou via un scheduler pour régénérer le calendrier.

## 📦 Dépendances

- `ical-generator` : Génération du fichier iCalendar
- `commons/dynamodb.sessions` : Accès aux sessions DynamoDB

## 📤 Sortie

```json
{
  "statusCode": 200,
  "body": "{\"message\": \"file updated\"}"
}
```

## 📁 Structure

```
calendar_generator/
├── app.ts              # Point d'entrée Lambda
├── src/
│   └── s3.images.ts    # Utilitaire pour upload S3
├── jest.config.ts      # Configuration des tests
├── package.json
└── tsconfig.json
```
