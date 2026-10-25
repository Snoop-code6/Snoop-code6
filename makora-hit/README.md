# MAKORA HIT

Outil de communication interne pour PME : une **messagerie d'équipe** (façon Slack) et un **wiki de pages** (façon Notion) réunis dans une seule application, simple à héberger.

## Fonctionnalités

**Messagerie**
- Canaux publics : créer, rejoindre, quitter ; `#general` créé automatiquement
- Messages privés entre deux personnes
- Temps réel (WebSocket) avec reconnexion automatique
- Compteurs de messages non lus, présence en ligne
- Modification / suppression de ses messages (les admins peuvent supprimer)
- Mise en forme Markdown : **gras**, *italique*, `code`, listes, liens, @mentions
- Historique paginé

**Pages**
- Pages et sous-pages, en arborescence dans la barre latérale
- Édition en Markdown avec aperçu, titres, listes de tâches, citations, blocs de code
- Enregistrement automatique
- Gestion des conflits : si deux personnes modifient la même page, personne n'écrase le travail de l'autre
- Mise à jour en direct quand un collègue modifie la page ouverte

**Commun**
- Comptes avec invitations : le premier inscrit devient administrateur, les suivants rejoignent via un lien d'invitation (usage unique, valable 7 jours)
- Recherche dans les messages et les pages (les messages privés ne sont visibles que de leurs participants)
- Interface en français, mode sombre automatique, utilisable sur mobile

## Démarrage

Prérequis : Node.js 22.5 ou plus récent. Aucune base de données à installer (SQLite est intégré à Node).

```bash
cd makora-hit
npm install
npm start
```

Ouvrez http://localhost:3000, créez le compte administrateur, puis invitez vos collègues avec le bouton **Inviter** en bas à gauche.

| Variable      | Défaut              | Rôle                                                        |
|---------------|---------------------|-------------------------------------------------------------|
| `PORT`        | `3000`              | Port HTTP                                                   |
| `HOST`        | toutes interfaces   | Adresse d'écoute                                            |
| `DB_FILE`     | `data/makora.db`    | Fichier SQLite (à sauvegarder régulièrement)                |
| `TRUST_PROXY` | non défini          | À définir (ex. `1`) derrière un reverse proxy HTTPS         |

En production, placez l'application derrière un reverse proxy HTTPS (Caddy, Nginx…) qui transmet aussi les WebSocket sur `/ws`.

## Développement

```bash
npm run dev   # redémarre à chaque modification
npm test      # tests de l'API, du temps réel et du rendu Markdown
```

### Organisation du code

```
src/
  server.js    démarrage HTTP + WebSocket
  app.js       routes de l'API REST (/api/...)
  realtime.js  diffusion des événements en temps réel
  auth.js      mots de passe (scrypt), sessions, cookies
  db.js        schéma SQLite
public/
  index.html, app.css, app.js   interface (JavaScript sans étape de build)
  markdown.js                   rendu Markdown sécurisé (partagé avec les tests)
test/
  api.test.js
```

### Sécurité

- Mots de passe hachés avec scrypt, sessions en cookie `HttpOnly` / `SameSite=Lax`
- Protection CSRF par en-tête obligatoire sur les écritures, vérification de l'origine des WebSocket
- Tout le contenu saisi est échappé avant le rendu Markdown ; seuls les liens `http(s)`, `mailto` et internes sont autorisés
- En-têtes de sécurité (CSP stricte, `X-Frame-Options`…), limitation des tentatives de connexion

## Pistes pour la suite

- Fils de discussion et réactions emoji sur les messages
- Pièces jointes (fichiers, images)
- Notifications navigateur et email
- Canaux privés à plusieurs, gestion des membres et des rôles par l'admin
- Éditeur de pages par blocs (WYSIWYG) et historique des versions
- Réinitialisation de mot de passe par email
