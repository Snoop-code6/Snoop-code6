#!/data/data/com.termux/files/usr/bin/bash
# Lance MAKORA HIT directement sur un téléphone Android, dans l'application Termux.
# À coller dans Termux (la même commande installe, met à jour et démarre) :
#   curl -fsSL https://raw.githubusercontent.com/Snoop-code6/Snoop-code6/claude/discussion-dev-senior-hqdxna/makora-hit/scripts/termux.sh | bash
set -euo pipefail

REPO=${MAKORA_REPO:-https://github.com/Snoop-code6/Snoop-code6}
BRANCH=${MAKORA_BRANCH:-claude/discussion-dev-senior-hqdxna}
DIR=${MAKORA_DIR:-$HOME/makora}

say() { printf '\n\033[1;34m▶ %s\033[0m\n' "$1"; }

if ! command -v node >/dev/null || ! command -v git >/dev/null; then
  say "Installation de Node.js et Git (quelques minutes la première fois)"
  export DEBIAN_FRONTEND=noninteractive
  pkg update -y -o Dpkg::Options::=--force-confnew
  pkg upgrade -y -o Dpkg::Options::=--force-confnew
  pkg install -y nodejs git
fi

if ! node -e "require('node:sqlite')" 2>/dev/null; then
  echo "Node.js $(node -v) est trop ancien (22.5 minimum). Lancez : pkg upgrade nodejs"
  exit 1
fi

if [ -d "$DIR/.git" ]; then
  say "Mise à jour de MAKORA HIT"
  git -C "$DIR" pull --ff-only --quiet || echo "(mise à jour impossible, on garde la version actuelle)"
else
  say "Téléchargement de MAKORA HIT"
  git clone --quiet --depth 1 --branch "$BRANCH" "$REPO" "$DIR"
fi

cd "$DIR/makora-hit"
say "Installation des dépendances"
npm install --omit=dev --no-audit --no-fund --loglevel=error

# Garde le téléphone éveillé pour que le serveur continue de tourner écran éteint.
command -v termux-wake-lock >/dev/null && termux-wake-lock
trap 'command -v termux-wake-unlock >/dev/null && termux-wake-unlock' EXIT

say "MAKORA HIT démarre"
cat <<'INFO'
  → Sur ce téléphone, ouvrez Chrome à l'adresse :  http://localhost:3000
    (ou l'application MAKORA HIT avec l'adresse :  localhost:3000)
  → Laissez Termux ouvert en arrière-plan. Pour arrêter : revenez ici et faites Ctrl + C.
  → Vos données restent sur le téléphone, dans ~/makora/makora-hit/data.
INFO
exec npm start
