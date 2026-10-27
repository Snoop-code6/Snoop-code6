package fr.makorahit.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.os.Message;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.net.URLDecoder;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Application Android de MAKORA HIT : affiche l'interface web du serveur de l'entreprise.
 * Au premier lancement, elle demande l'adresse de ce serveur.
 */
public class MainActivity extends Activity {
    private static final String PREFS = "makora";
    private static final String KEY_SERVER = "server";
    private static final int PICK_FILES = 1;
    private static final int DARK = Color.rgb(0x1f, 0x22, 0x33);
    private static final int ACCENT = Color.rgb(0x4f, 0x46, 0xe5);

    private FrameLayout root;
    private WebView web;
    private String server;
    private ValueCallback<Uri[]> pendingFiles;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(DARK);
        getWindow().setNavigationBarColor(DARK);
        root = new FrameLayout(this);
        setContentView(root);
        server = prefs().getString(KEY_SERVER, null);
        if (server == null) showSetup(null);
        else openApp(state);
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private int dp(int value) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics());
    }

    // --- Écran de configuration du serveur ---------------------------------------------

    private void showSetup(String error) {
        destroyWeb();
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER_VERTICAL);
        box.setPadding(dp(28), dp(28), dp(28), dp(28));
        box.setBackgroundColor(Color.WHITE);

        TextView brand = new TextView(this);
        brand.setText("MAKORA HIT");
        brand.setTextColor(ACCENT);
        brand.setTextSize(26);
        brand.setTypeface(null, android.graphics.Typeface.BOLD);
        box.addView(brand);

        TextView intro = new TextView(this);
        intro.setText("Adresse du serveur de votre entreprise :\n"
                + "par exemple https://chat.mon-entreprise.fr\n"
                + "ou, pour un test sur le même Wi-Fi, http://192.168.1.20:3000");
        intro.setTextSize(15);
        intro.setTextColor(Color.DKGRAY);
        intro.setPadding(0, dp(16), 0, dp(12));
        box.addView(intro);

        final EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setHint("https://…");
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setImeOptions(EditorInfo.IME_ACTION_GO);
        if (server != null) input.setText(server);
        box.addView(input);

        if (error != null) {
            TextView err = new TextView(this);
            err.setText(error);
            err.setTextColor(Color.rgb(0xc6, 0x28, 0x28));
            err.setPadding(0, dp(8), 0, 0);
            box.addView(err);
        }

        Button go = new Button(this);
        go.setText("Se connecter");
        go.setTextColor(Color.WHITE);
        go.setBackgroundColor(ACCENT);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48));
        lp.topMargin = dp(16);
        box.addView(go, lp);

        View.OnClickListener submit = new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                String url = normalize(input.getText().toString());
                if (url == null) {
                    showSetup("Adresse invalide. Exemple : https://chat.mon-entreprise.fr");
                    return;
                }
                server = url;
                prefs().edit().putString(KEY_SERVER, url).apply();
                openApp(null);
            }
        };
        go.setOnClickListener(submit);
        input.setOnEditorActionListener(new TextView.OnEditorActionListener() {
            @Override
            public boolean onEditorAction(TextView v, int actionId, KeyEvent event) {
                submit.onClick(v);
                return true;
            }
        });

        root.removeAllViews();
        root.addView(box);
    }

    // « chat.pme.fr » devient https://chat.pme.fr ; une adresse IP locale passe en http.
    static String normalize(String raw) {
        String s = raw.trim();
        if (s.isEmpty()) return null;
        if (!s.startsWith("http://") && !s.startsWith("https://")) {
            boolean local = s.matches("^(localhost|10\\.|192\\.168\\.|172\\.(1[6-9]|2\\d|3[01])\\.|\\d+\\.\\d+\\.\\d+\\.\\d+).*");
            s = (local ? "http://" : "https://") + s;
        }
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        Uri uri = Uri.parse(s);
        if (uri.getHost() == null || uri.getHost().isEmpty()) return null;
        return s;
    }

    // --- Application web ---------------------------------------------------------------

    private void destroyWeb() {
        if (web != null) {
            root.removeView(web);
            web.destroy();
            web = null;
        }
    }

    private boolean sameServer(Uri uri) {
        Uri base = Uri.parse(server);
        return base.getHost() != null && base.getHost().equalsIgnoreCase(uri.getHost()) && base.getPort() == uri.getPort();
    }

    private void openExternally(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception e) {
            Toast.makeText(this, "Aucune application pour ouvrir ce lien.", Toast.LENGTH_SHORT).show();
        }
    }

    private void openApp(Bundle state) {
        destroyWeb();
        root.removeAllViews();
        web = new WebView(this);
        web.setBackgroundColor(Color.WHITE);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportMultipleWindows(true);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setUserAgentString(s.getUserAgentString() + " MakoraHitAndroid/1.0");
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);

        web.setWebViewClient(new WebViewClient() {
            // Variante « String » : disponible dès Android 6, et appelée par défaut par les versions récentes.
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                Uri uri = Uri.parse(url);
                String scheme = uri.getScheme();
                // mailto:, tel:… : applications du téléphone.
                if (!"http".equals(scheme) && !"https".equals(scheme)) {
                    openExternally(uri);
                    return true;
                }
                return false;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    showOffline(String.valueOf(error.getDescription()));
                }
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            // Liens « nouvel onglet » : ceux du serveur restent dans l'application, les autres
            // s'ouvrent dans le navigateur.
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                final WebView probe = new WebView(MainActivity.this);
                probe.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, String url) {
                        Uri uri = Uri.parse(url);
                        if (sameServer(uri)) web.loadUrl(uri.toString());
                        else openExternally(uri);
                        probe.destroy();
                        return true;
                    }
                });
                ((WebView.WebViewTransport) resultMsg.obj).setWebView(probe);
                resultMsg.sendToTarget();
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingFiles != null) pendingFiles.onReceiveValue(null);
                pendingFiles = callback;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try {
                    startActivityForResult(Intent.createChooser(intent, "Choisir un fichier"), PICK_FILES);
                } catch (Exception e) {
                    pendingFiles = null;
                    return false;
                }
                return true;
            }
        });

        // Pièces jointes : téléchargées avec la session de l'application, dans Téléchargements.
        web.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String disposition, String mime, long length) {
                try {
                    String name = fileName(url, disposition, mime);
                    DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                    req.addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url));
                    req.addRequestHeader("User-Agent", userAgent);
                    req.setTitle(name);
                    req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                    req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
                    ((DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE)).enqueue(req);
                    Toast.makeText(MainActivity.this, "Téléchargement de " + name, Toast.LENGTH_SHORT).show();
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "Téléchargement impossible.", Toast.LENGTH_LONG).show();
                }
            }
        });

        if (state != null) web.restoreState(state);
        else web.loadUrl(server + "/");
    }

    static String fileName(String url, String disposition, String mime) {
        if (disposition != null) {
            Matcher m = Pattern.compile("filename\\*=UTF-8''([^;]+)", Pattern.CASE_INSENSITIVE).matcher(disposition);
            if (m.find()) {
                try {
                    return URLDecoder.decode(m.group(1), "UTF-8").replaceAll("[\\\\/:*?\"<>|]", "_");
                } catch (Exception ignored) {
                    // Nom illisible : repli plus bas.
                }
            }
        }
        return URLUtil.guessFileName(url, disposition, mime);
    }

    private void showOffline(String detail) {
        destroyWeb();
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setPadding(dp(28), dp(28), dp(28), dp(28));
        box.setBackgroundColor(Color.WHITE);

        TextView title = new TextView(this);
        title.setText("Serveur injoignable");
        title.setTextSize(22);
        title.setTextColor(Color.BLACK);
        title.setGravity(Gravity.CENTER);
        box.addView(title);

        TextView text = new TextView(this);
        text.setText(server + "\n\nVérifiez votre connexion, ou que le serveur est bien démarré.\n(" + detail + ")");
        text.setGravity(Gravity.CENTER);
        text.setTextColor(Color.DKGRAY);
        text.setPadding(0, dp(12), 0, dp(20));
        box.addView(text);

        Button retry = new Button(this);
        retry.setText("Réessayer");
        retry.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                openApp(null);
            }
        });
        box.addView(retry);

        Button change = new Button(this);
        change.setText("Changer d'adresse");
        change.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                showSetup(null);
            }
        });
        box.addView(change);

        root.removeAllViews();
        root.addView(box);
    }

    // --- Cycle de vie ------------------------------------------------------------------

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != PICK_FILES || pendingFiles == null) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                result = new Uri[data.getClipData().getItemCount()];
                for (int i = 0; i < result.length; i++) result[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) {
                result = new Uri[] { data.getData() };
            }
        }
        pendingFiles.onReceiveValue(result);
        pendingFiles = null;
    }

    // Retour : navigation dans l'application ; à la racine, proposer de quitter ou de changer de serveur.
    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle("MAKORA HIT")
                .setItems(new CharSequence[] { "Quitter", "Changer d'adresse du serveur" }, new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        if (which == 0) finish();
                        else showSetup(null);
                    }
                })
                .show();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null) web.saveState(out);
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
        if (web != null) web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onDestroy() {
        destroyWeb();
        super.onDestroy();
    }
}
