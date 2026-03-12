# Algolia Users Indexer Lambda

Lambda consommatrice du stream DynamoDB de `Efrei-Sport-Climbing-App.users` pour synchroniser les fiches utilisateurs vers Algolia.

## Variables d'environnement

- `ALGOLIA_SECRET_PATH`: chemin Secrets Manager contenant `ALGOLIA_APP_ID` et `ALGOLIA_ADMIN_API_KEY`
- `ALGOLIA_USERS_INDEX`: nom de l'index Algolia cible

## Déclencheur

- DynamoDB Stream sur `UsersTable` avec `NEW_AND_OLD_IMAGES`
