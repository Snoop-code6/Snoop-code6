# MAKORA HIT

Outil de communication interne pour PME : une **messagerie d'équipe** (façon Slack) et un **wiki de pages** (façon Notion) réunis dans une seule application, simple à héberger.

## Fonctionnalités

**Messagerie**
- Canaux publics : créer, rejoindre, quitter ; `#general` créé automatiquement
- **Canaux privés** 🔒 : invisibles pour les non-membres ; les membres ajoutent des personnes, le créateur du canal et les administrateurs peuvent en retirer, chacun peut partir
- Liste des membres de chaque canal, ajout de personnes dès la création
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
- **Historique des versions** : qui a modifié quoi et quand, comparaison ligne à ligne avec la version actuelle, restauration en un clic (les enregistrements automatiques d'une même personne à moins de 10 minutes d'intervalle forment une seule version ; 200 versions conservées par page)

**Notifications**
- Onglet **Activité** avec badge : mentions, réponses dans les fils auxquels on participe, réactions à ses messages
- Une notification déjà sous les yeux (canal ou fil ouvert) est marquée comme lue automatiquement
- **Notifications push** sur ordinateur et mobile, même application fermée : mentions, réponses dans les fils, réactions et messages privés. Elles ne partent que si aucun onglet n'est au premier plan, pour éviter les doublons
- Le nombre total de non-lus s'affiche dans le titre de l'onglet

**Commun**
- Comptes avec invitations : le premier inscrit devient administrateur, les suivants rejoignent via un lien d'invitation (usage unique, valable 7 jours)
- Recherche dans les messages et les pages (les messages privés ne sont visibles que de leurs participants)
- Interface en français, mode sombre automatique, utilisable sur mobile
- **Application installable** (PWA) sur Android, iPhone, Windows et macOS : icône sur l'écran d'accueil, plein écran, démarrage même hors ligne

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
| `VAPID_SUBJECT` | `mailto:` + email du 1er admin | Contact transmis aux services push (Google, Apple, Mozilla) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | générées au 1er démarrage | Clés des notifications push ; par défaut créées une fois et conservées en base |

La base de données est mise à niveau automatiquement au démarrage quand une nouvelle version ajoute des fonctionnalités.

En production, placez l'application derrière un reverse proxy HTTPS (Caddy, Nginx…) qui transmet aussi les WebSocket sur `/ws`. **Le HTTPS est indispensable** pour installer l'application et recevoir les notifications push (seul `localhost` en est dispensé).

### Installer l'application et activer les notifications

- **Android / Chrome / Edge** : bouton « 📲 Installer l'application » dans la barre latérale (ou menu du navigateur → Installer).
- **iPhone / iPad** (iOS 16.4 ou plus récent) : dans Safari, Partager → « Sur l'écran d'accueil ». Les notifications push ne fonctionnent sur iOS qu'une fois l'application installée ainsi.
- Puis, dans l'onglet **Activité** : « Activer les notifications sur cet appareil ». À la déconnexion, l'appareil cesse de recevoir les notifications du compte.

⚠️ Changer les clés VAPID (ou perdre la base) désabonne tous les appareils : chacun devra réactiver les notifications.

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
  push.js      envoi des notifications push (clés VAPID)
  auth.js      mots de passe (scrypt), sessions, cookies
  db.js        schéma SQLite
public/
  index.html, app.css, app.js   interface (JavaScript sans étape de build)
  markdown.js                   rendu Markdown sécurisé (partagé avec le serveur et les tests)
  sw.js                         service worker : démarrage hors ligne et notifications push
  manifest.webmanifest, icons/  application installable
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
- Préférences de notification par canal (muet, mentions uniquement)
- Gestion des rôles par l'admin (nommer d'autres administrateurs, désactiver un compte)
- Renommer / archiver un canal
- Éditeur de pages par blocs (WYSIWYG)
- Réinitialisation de mot de passe par email
