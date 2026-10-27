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
- **Notifications réglables par canal** : tous les messages, mentions uniquement (par défaut) ou muet (plus de compteur ; une mention directe passe toujours)
- Historique paginé

**Pages**
- Pages et sous-pages, en arborescence dans la barre latérale
- Édition en Markdown avec aperçu, titres, listes de tâches, citations, blocs de code
- **Images et fichiers dans les pages** : bouton, glisser-déposer ou copier-coller d'une capture ; les images s'affichent dans la page, les autres fichiers se téléchargent ; liste des fichiers de chaque page
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
- **Connexion avec Google Workspace ou Microsoft 365** (optionnelle) : les collègues de vos domaines obtiennent un compte automatiquement à leur première connexion
- **Emails** (optionnels) : invitations envoyées par email (lien réservé à l'adresse invitée), « mot de passe oublié » en libre-service, liens de réinitialisation envoyés par l'admin, **résumé par email** des mentions et réponses restées non lues plus de 15 minutes (au plus un par heure, désactivable)
- **Mon compte** : changer son nom et son mot de passe (les autres appareils sont alors déconnectés), préférences d'email
- **Administration** : nommer ou retirer des administrateurs, désactiver / réactiver un compte (déconnexion immédiate partout, messages conservés), lien de réinitialisation de mot de passe (usage unique, 24 h), invitations en attente (afficher, révoquer)
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
| `PUBLIC_URL` | non défini | Adresse publique (ex. `https://chat.mon-entreprise.fr`) ; **obligatoire** pour les emails et le SSO |
| `SMTP_URL` | non défini | Serveur d'envoi d'emails, ex. `smtps://utilisateur:motdepasse@smtp.fournisseur.fr:465` |
| `MAIL_FROM` | `MAKORA HIT <no-reply@localhost>` | Expéditeur des emails |
| `EMAIL_DIGEST_DELAY_MIN` | `15` | Délai avant d'envoyer par email une notification non lue |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | non définis | Connexion SSO (voir ci-dessous) |
| `OIDC_LABEL` | `SSO` | Texte du bouton : « Se connecter avec … » |
| `OIDC_ALLOWED_DOMAINS` | aucun | Domaines dont les personnes obtiennent un compte automatiquement (ex. `mon-entreprise.fr,filiale.fr`) ; sinon il faut une invitation |
| `OIDC_TRUST_EMAIL` | `false` | À mettre à `true` pour Microsoft 365 avec un locataire précis (voir ci-dessous) |
| `VAPID_SUBJECT` | `mailto:` + email du 1er admin | Contact transmis aux services push (Google, Apple, Mozilla) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | générées au 1er démarrage | Clés des notifications push ; par défaut créées une fois et conservées en base |

La base de données est mise à niveau automatiquement au démarrage quand une nouvelle version ajoute des fonctionnalités.

En production, placez l'application derrière un reverse proxy HTTPS (Caddy, Nginx…) qui transmet aussi les WebSocket sur `/ws`. **Le HTTPS est indispensable** pour installer l'application et recevoir les notifications push (seul `localhost` en est dispensé).

### Installer l'application et activer les notifications

- **Android / Chrome / Edge** : bouton « 📲 Installer l'application » dans la barre latérale (ou menu du navigateur → Installer).
- **iPhone / iPad** (iOS 16.4 ou plus récent) : dans Safari, Partager → « Sur l'écran d'accueil ». Les notifications push ne fonctionnent sur iOS qu'une fois l'application installée ainsi.
- Puis, dans l'onglet **Activité** : « Activer les notifications sur cet appareil ». À la déconnexion, l'appareil cesse de recevoir les notifications du compte.

⚠️ Changer les clés VAPID (ou perdre la base) désabonne tous les appareils : chacun devra réactiver les notifications.

### Emails

N'importe quel service SMTP convient : celui de votre messagerie (Microsoft 365, Google Workspace, OVH…) ou un service d'envoi (Brevo, Mailjet, Amazon SES…). Renseignez `SMTP_URL`, `MAIL_FROM` et `PUBLIC_URL`. Les liens contenus dans les emails sont toujours construits à partir de `PUBLIC_URL`, jamais à partir de la requête reçue.

Sans SMTP, tout fonctionne quand même : les liens d'invitation et de réinitialisation s'affichent à l'écran pour être transmis à la main.

### Connexion avec Google Workspace ou Microsoft 365

L'adresse de retour à déclarer chez le fournisseur est `PUBLIC_URL` + `/api/auth/sso/callback`.

- **Google Workspace** : console Google Cloud → API et services → Identifiants → « ID client OAuth » (application Web), avec l'adresse de retour ci-dessus. Puis :
  `OIDC_ISSUER=https://accounts.google.com`, `OIDC_CLIENT_ID=…`, `OIDC_CLIENT_SECRET=…`, `OIDC_LABEL=Google`, `OIDC_ALLOWED_DOMAINS=mon-entreprise.fr`.
- **Microsoft 365 / Entra ID** : portail Azure → Entra ID → Inscriptions d'applications → Nouvelle inscription (plateforme Web, adresse de retour ci-dessus), puis créez un secret client. Utilisez l'émetteur **de votre locataire** :
  `OIDC_ISSUER=https://login.microsoftonline.com/<ID du locataire>/v2.0`, `OIDC_LABEL=Microsoft`, `OIDC_ALLOWED_DOMAINS=mon-entreprise.fr`, `OIDC_TRUST_EMAIL=true`.
  (Microsoft n'indique pas si l'adresse est vérifiée ; avec l'émetteur de votre propre locataire, ce sont vos administrateurs qui gèrent les adresses, d'où `OIDC_TRUST_EMAIL`. Ne l'activez jamais avec l'émetteur `common`.)

Le compte administrateur initial se crée toujours avec un mot de passe. Une personne déjà inscrite peut ensuite se connecter par SSO avec la même adresse ; un compte désactivé reste refusé.

## Application Android (APK)

Le dossier `android/` contient une petite application Android qui affiche MAKORA HIT en plein écran. Au premier lancement, elle demande l'adresse du serveur. Elle gère l'envoi de fichiers, le téléchargement des pièces jointes et le bouton retour ; un retour sur l'écran d'accueil de l'application permet de changer de serveur.

```bash
sudo apt-get install android-sdk-platform-23 aapt apksigner zipalign dalvik-exchange default-jdk
./android/build.sh        # → android/build/makora-hit.apk
```

Limites par rapport à l'application installée depuis Chrome (PWA) :
- **pas de notifications push** (Android ne les permet pas dans une application de ce type) ;
- **pas de connexion « avec Google »** : Google interdit sa page de connexion dans les applications intégrées (la connexion par mot de passe fonctionne).

Pour un usage quotidien, l'installation depuis Chrome (menu → Installer l'application) reste la meilleure option ; l'APK sert surtout à tester ou à distribuer l'application sans passer par le navigateur. La clé de signature est créée dans `android/build/` au premier lancement : conservez-la pour publier des mises à jour sans devoir désinstaller l'application.

## Tester sur un téléphone Android, sans ordinateur ni hébergement

Avec l'application **Termux**, le serveur tourne directement sur le téléphone :

1. Installez Termux depuis [F-Droid](https://f-droid.org/packages/com.termux/) ou les [versions GitHub](https://github.com/termux/termux-app/releases) (fichier `…universal.apk`).
2. Ouvrez Termux et collez :
   ```bash
   curl -fsSL https://raw.githubusercontent.com/Snoop-code6/Snoop-code6/claude/discussion-dev-senior-hqdxna/makora-hit/scripts/termux.sh | bash
   ```
3. Ouvrez `http://localhost:3000` dans Chrome (ou l'APK avec l'adresse `localhost:3000`).

La même commande met l'application à jour et la relance. Les données restent sur le téléphone. Seul ce téléphone peut s'y connecter (ou les appareils du même Wi-Fi) : pour toute l'équipe, il faut un hébergement.

## Mise en ligne sur Railway (le plus simple)

Tout se fait dans le navigateur, sans ligne de commande. Railway fournit une adresse HTTPS (`xxx.up.railway.app`).

1. Créez un compte sur [railway.com](https://railway.com) en vous connectant avec GitHub.
2. **New Project** → **Deploy from GitHub repo** → choisissez ce dépôt (autorisez l'accès si Railway le demande).
3. Dans le service créé, onglet **Settings** :
   - **Source** → *Root Directory* : `/makora-hit` ; *Branch* : la branche à déployer ;
   - **Networking** → **Generate Domain** (avant le premier déploiement réussi : l'application a besoin de connaître son adresse).
4. Onglet **Variables** → ajoutez :
   - `PUBLIC_URL` = `https://${{RAILWAY_PUBLIC_DOMAIN}}`
   - `TRUST_PROXY` = `1`
   - `RAILWAY_RUN_UID` = `0` (Railway monte les volumes avec les droits administrateur ; sans cette variable l'application ne peut pas y écrire)
5. Clic droit sur le service (ou **+ Create**) → **Volume**, chemin de montage : `/data`. **Indispensable** : sans volume, la base et les fichiers sont effacés à chaque redéploiement.
6. Laissez Railway redéployer, ouvrez l'adresse générée et **créez immédiatement le compte administrateur** (le premier inscrit devient admin).

Chaque nouveau commit sur la branche choisie est redéployé automatiquement ; la base est migrée au démarrage. Une seule instance (le réglage par défaut) : SQLite ne se partage pas entre plusieurs copies de l'application.

## Mise en ligne sur votre propre serveur

Le plus simple : un petit serveur Linux (VPS à quelques euros par mois chez OVHcloud, Scaleway, Hetzner…) avec Docker, et un nom de domaine (ou sous-domaine) qui pointe vers lui.

1. **DNS** : créez un enregistrement `A` (ex. `chat.mon-entreprise.fr`) vers l'adresse IP du serveur.
2. **Sur le serveur** (ports 80 et 443 ouverts) :
   ```bash
   git clone <ce dépôt> && cd makora-hit
   DOMAIN=chat.mon-entreprise.fr docker compose up -d
   ```
3. Ouvrez `https://chat.mon-entreprise.fr` et créez le compte administrateur **tout de suite** (le premier inscrit devient admin).

Caddy obtient et renouvelle automatiquement le certificat HTTPS. Les données (base + pièces jointes) sont dans le volume Docker `makora-data`.

**Mettre à jour** : `git pull && DOMAIN=chat.mon-entreprise.fr docker compose up -d --build` (la base est migrée automatiquement).

**Sauvegarder** (à planifier chaque nuit, par exemple avec cron) :
```bash
# 1. Instantané cohérent de la base dans le volume (les 14 derniers sont conservés)
docker compose exec app node --disable-warning=ExperimentalWarning src/backup.js
# 2. Copie hors du serveur : base sauvegardée + pièces jointes
docker run --rm -v makora-hit_makora-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/makora-$(date +%F).tar.gz -C /data backups uploads
```
Pensez à copier cette archive ailleurs (autre serveur, stockage objet) : une sauvegarde sur la même machine ne protège pas d'une panne de disque.

**Restaurer** : arrêtez l'application, remplacez `/data/makora.db` par une sauvegarde (en supprimant `makora.db-wal` et `makora.db-shm`), remettez le dossier `uploads`, puis relancez.

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
  mailer.js, emails.js   envoi des emails et leurs modèles
  oidc.js      connexion SSO (OpenID Connect, PKCE, vérification des jetons)
  auth.js      mots de passe (scrypt), sessions, cookies
  db.js        schéma SQLite
  backup.js    sauvegarde cohérente de la base
android/       application Android (WebView) et son script de construction
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

- Renommer / archiver un canal
- Éditeur de pages par blocs (WYSIWYG)
