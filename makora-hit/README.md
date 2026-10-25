# MAKORA HIT

Outil de communication interne pour PME : une **messagerie d'équipe** (façon Slack) et un **wiki de pages** (façon Notion) réunis dans une seule application, simple à héberger.

## Fonctionnalités

**Messagerie**
- Canaux publics : créer, rejoindre, quitter ; `#general` créé automatiquement
- Messages privés entre deux personnes
- Temps réel (WebSocket) avec reconnexion automatique
- Compteurs de messages non lus, présence en ligne
- **Fils de discussion** : répondre à un message sans encombrer le canal, compteur de réponses en direct
- **Pièces jointes** : bouton trombone, glisser-déposer ou copier-coller ; aperçu des images, téléchargement des autres fichiers (10 par message, 20 Mo chacun par défaut)
- Modification / suppression de ses messages (les admins peuvent supprimer)
- **Réactions emoji** : pastilles cliquables sous les messages, sélecteur d'emojis
- **@mentions** avec autocomplétion (`@Prénom Nom`, ou `@tous` pour prévenir tout le canal)
- Mise en forme Markdown : **gras**, *italique*, `code`, listes, liens
- Historique paginé

**Pages**
- Pages et sous-pages, en arborescence dans la barre latérale
- Édition en Markdown avec aperçu, titres, listes de tâches, citations, blocs de code
- Enregistrement automatique
- Gestion des conflits : si deux personnes modifient la même page, personne n'écrase le travail de l'autre
- Mise à jour en direct quand un collègue modifie la page ouverte

**Notifications**
- Onglet **Activité** avec badge : mentions, réponses dans les fils auxquels on participe, réactions à ses messages
- Une notification déjà sous les yeux (canal ou fil ouvert) est marquée comme lue automatiquement
- Notifications du bureau (optionnelles) quand l'onglet est en arrière-plan, y compris pour les messages privés
- Le nombre total de non-lus s'affiche dans le titre de l'onglet

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
| `UPLOAD_DIR`  | `data/uploads`      | Dossier des pièces jointes (à sauvegarder avec la base)     |
| `MAX_UPLOAD_MB` | `20`              | Taille maximale d'une pièce jointe, en Mo                   |
| `TRUST_PROXY` | non défini          | À définir (ex. `1`) derrière un reverse proxy HTTPS         |

La base de données est mise à niveau automatiquement au démarrage quand une nouvelle version ajoute des fonctionnalités.

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
- Les pièces jointes suivent les droits du canal (un fichier d'une conversation privée reste privé) ; seules les images PNG, JPEG, GIF et WebP s'affichent dans la page, tout autre fichier (HTML, SVG…) est forcé en téléchargement dans un bac à sable
- Tout le contenu saisi est échappé avant le rendu Markdown ; seuls les liens `http(s)`, `mailto` et internes sont autorisés
- En-têtes de sécurité (CSP stricte, `X-Frame-Options`…), limitation des tentatives de connexion

## Pistes pour la suite

- Pièces jointes dans les pages
- Notifications par email (résumé des mentions non lues)
- Notifications push sur mobile (application installable / service worker)
- Préférences de notification par canal (muet, mentions uniquement)
- Canaux privés à plusieurs, gestion des membres et des rôles par l'admin
- Éditeur de pages par blocs (WYSIWYG) et historique des versions
- Réinitialisation de mot de passe par email
