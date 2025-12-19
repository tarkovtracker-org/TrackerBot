# Mise en service du formulaire `bug-report-data`

Ce guide explique comment activer le formulaire `/bug-report-data/` et le message Discord associé pour que les signalements de données arrivent correctement dans `tarkovtracker-org/tarkov-data/overlay`.

## 1. Préparer l’environnement

1. Copier `.env.example` vers `.env` si ce n’est pas déjà fait.
2. Renseigner les variables suivantes :
   - `GITHUB_TOKEN` : un token « classic » avec la permission `repo` suffit (pas besoin d’ajouter explicitement le dépôt cible tant que le token peut créer des issues). Ce même token est utilisé pour le dépôt principal (`GITHUB_REPO`) et pour `tarkovtracker-org/tarkov-data/overlay`.
   - `GITHUB_REPO` : dépôt GitHub qui accueille les bugs « classiques » (ex. `tarkovtracker-org/TrackerBot`).
   - `PORT` : port HTTP du serveur de formulaires (`3000` par défaut). Si un reverse proxy publie `https://issue.tarkovtracker.org`, faire pointer le proxy sur `localhost:3000`.
   - `DATA_BUG_CHANNEL_ID` : salon Discord où le bot doit poster la carte « Data Bug Report ».
3. Vérifier également `BUG_REPORT_CHANNEL_ID`, `ROLE_CHANNEL_ID`, `TICKET_CHANNEL_ID`, `WELCOME_CHANNEL_ID` et `DISCORD_TOKEN`, car le bot doit redémarrer pour republier les messages.

## 2. Lancer les services

1. Sur votre machine locale : `npm install` (une seule fois) puis `npm start`. Cela lance :
   - `bot.js`
   - `webserver.js` (sert `/` et `/bug-report-data/`)
   - `adminserver.js`
2. En production (PM2) : relancer `pm2 reload ecosystem.config.cjs --update-env` ou exécuter `npm run deploy-prod` via le workflow/SSH pour prendre en compte les nouvelles variables.

## 3. Vérifications manuelles

1. **Formulaire principal** : ouvrir `http://localhost:3000/` (ou votre domaine) et s’assurer que la page se charge.
2. **Formulaire data** : ouvrir `http://localhost:3000/bug-report-data/`. Si la page ne charge pas, regarder les logs `webserver.js` (processus `TrackerBot` → préfixe `web` dans `npm start` ou `pm2 logs TrackerBot`).
3. Soumettre un test :
   - Un rapport classique doit créer une issue dans `GITHUB_REPO`.
   - Un rapport data doit créer une issue dans `tarkovtracker-org/tarkov-data/overlay` avec le préfixe `[<Categorie>]`.
4. Si GitHub renvoie une erreur `401/403`, vérifier que `GITHUB_TOKEN` est valide, qu’il a accès aux deux dépôts et redémarrer le serveur (les variables sont chargées au lancement).

## 4. Mise à jour du message Discord

1. Après avoir configuré `DATA_BUG_CHANNEL_ID`, redémarrer le bot (`npm start` ou relance PM2). Il supprimera les anciens messages et repostera :
   - Carte « Bug Report » (salon `BUG_REPORT_CHANNEL_ID`)
   - Carte « Data Bug Report » (salon `DATA_BUG_CHANNEL_ID`)
2. Confirmer que le bouton « Data Bug Report » pointe vers `https://issue.tarkovtracker.org/bug-report` (ou l’URL configurée par votre reverse proxy).

## 5. Checklist rapide

- [ ] `.env` rempli avec tous les IDs + `PORT`
- [ ] `GITHUB_TOKEN` avec accès aux deux dépôts
- [ ] `npm start` (local) ou déploiement PM2 en cours d’exécution
- [ ] `/bug-report-data/` accessible et fonctionnel
- [ ] Nouvelle carte « Data Bug Report » visible sur Discord dans le salon configuré
