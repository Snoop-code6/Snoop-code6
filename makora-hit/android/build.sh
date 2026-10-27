#!/usr/bin/env bash
# Construit l'APK Android de MAKORA HIT sans Android Studio, avec les outils des paquets Ubuntu :
#   sudo apt-get install android-sdk-platform-23 aapt apksigner zipalign dalvik-exchange default-jdk
#   ./build.sh            → build/makora-hit.apk
# La clé de signature (build/makora-hit.keystore) est créée au premier lancement : gardez-la,
# elle est nécessaire pour publier des mises à jour de l'application sans la désinstaller.
set -euo pipefail
cd "$(dirname "$0")"

ANDROID_JAR=${ANDROID_JAR:-/usr/lib/android-sdk/platforms/android-23/android.jar}
VERSION_CODE=${VERSION_CODE:-1}
VERSION_NAME=${VERSION_NAME:-1.0}
KEYSTORE=${KEYSTORE:-build/makora-hit.keystore}
KEY_PASS=${KEY_PASS:-makora-hit}

rm -rf build/classes build/dex build/*.apk
mkdir -p build/classes build/dex

echo "1/5 Compilation Java"
javac -nowarn -Xlint:-options --release 8 -encoding UTF-8 -cp "$ANDROID_JAR" -d build/classes $(find src -name '*.java')

echo "2/5 Conversion en bytecode Android"
dalvik-exchange --dex --min-sdk-version=23 --output=build/dex/classes.dex build/classes

echo "3/5 Empaquetage (manifeste, icônes)"
# targetSdk 34 : installable sur les Android récents ; resources.arsc non compressé (exigé depuis Android 11).
aapt package -f -M AndroidManifest.xml -S res -I "$ANDROID_JAR" \
  --min-sdk-version 23 --target-sdk-version 34 \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  -0 arsc -F build/unsigned.apk
(cd build/dex && aapt add -0 arsc ../unsigned.apk classes.dex > /dev/null)

echo "4/5 Alignement"
zipalign -f -p 4 build/unsigned.apk build/aligned.apk

echo "5/5 Signature"
if [ ! -f "$KEYSTORE" ]; then
  keytool -genkeypair -keystore "$KEYSTORE" -storepass "$KEY_PASS" -keypass "$KEY_PASS" -alias makora \
    -keyalg RSA -keysize 3072 -validity 10000 -dname "CN=MAKORA HIT, O=MAKORA HIT, C=FR" > /dev/null 2>&1
fi
apksigner sign --ks "$KEYSTORE" --ks-pass "pass:$KEY_PASS" --ks-key-alias makora \
  --min-sdk-version 23 --out build/makora-hit.apk build/aligned.apk
rm -f build/unsigned.apk build/aligned.apk build/makora-hit.apk.idsig

apksigner verify --min-sdk-version 23 build/makora-hit.apk
echo "APK prêt : $(pwd)/build/makora-hit.apk ($(du -h build/makora-hit.apk | cut -f1))"
