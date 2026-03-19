# Algolia Users Indexer Lambda

Lambda consommatrice du stream DynamoDB de `Efrei-Sport-Climbing-App.users` pour synchroniser les fiches utilisateurs vers Algolia.

## Variables d'environnement

- `ALGOLIA_SECRET_PATH`: chemin Secrets Manager contenant `ALGOLIA_APP_ID` et `ALGOLIA_ADMIN_API_KEY`
- `ALGOLIA_USERS_INDEX`: nom de l'index Algolia cible
- `USER_STATS_TABLE_NAME`: table DynamoDB contenant les agrégats utilisateurs pré-calculés

## Déclencheur

- DynamoDB Stream sur `UsersTable` avec `NEW_AND_OLD_IMAGES`

## Backfill initial

Le flux live enrichit désormais les profils avec `UserStatsTable`.

Le bootstrap complet de l'index doit être réalisé avec :

```bash
poetry run python utils/algolia/build_user_stats_and_algolia_backfill.py --mode all
```

Ce script :

- scanne les tables DynamoDB sources une seule fois
- met les données en cache localement dans `tmp/algolia-user-backfill/`
- reconstruit les `userId` manquants des lignes de tickets via HelloAsso
- remplit `UserStatsTable`
- écrit les enregistrements enrichis dans Algolia
