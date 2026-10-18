package com.rusted.rtcoder;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import com.chaquo.python.Python;
import com.chaquo.python.android.AndroidPlatform;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

public class MainActivity extends Activity {
    private static final int PORT = 8760;
    private WebView webView;
    private FrameLayout root;
    private ProgressBar progress;
    private TextView status;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window w = getWindow();
        w.setStatusBarColor(Color.BLACK);
        w.setNavigationBarColor(Color.rgb(245, 245, 247));
        w.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        root = new FrameLayout(this);
        webView = new WebView(this);
        webView.setBackgroundColor(Color.WHITE);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        webView.setWebViewClient(new WebViewClient());
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onJsAlert(WebView view, String url, String message, final android.webkit.JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                    .setMessage(message)
                    .setPositiveButton("确定", (d, i) -> result.confirm())
                    .setOnCancelListener(d -> result.cancel())
                    .show();
                return true;
            }
            @Override
            public boolean onJsConfirm(WebView view, String url, String message, final android.webkit.JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                    .setMessage(message)
                    .setPositiveButton("确定", (d, i) -> result.confirm())
                    .setNegativeButton("取消", (d, i) -> result.cancel())
                    .setOnCancelListener(d -> result.cancel())
                    .show();
                return true;
            }
            @Override
            public boolean onJsPrompt(WebView view, String url, String message, String defaultValue,
                                      final android.webkit.JsPromptResult result) {
                final android.widget.EditText input = new android.widget.EditText(MainActivity.this);
                input.setText(defaultValue == null ? "" : defaultValue);
                input.setSelection(input.getText().length());
                int pad = (int) (16 * getResources().getDisplayMetrics().density);
                input.setPadding(pad, pad / 2, pad, pad / 2);
                new AlertDialog.Builder(MainActivity.this)
                    .setMessage(message)
                    .setView(input)
                    .setPositiveButton("确定", (d, i) -> result.confirm(input.getText().toString()))
                    .setNegativeButton("取消", (d, i) -> result.cancel())
                    .setOnCancelListener(d -> result.cancel())
                    .show();
                return true;
            }
        });
        root.addView(webView, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        progress = new ProgressBar(this);
        FrameLayout.LayoutParams pp = new FrameLayout.LayoutParams(72, 72, Gravity.CENTER);
        pp.bottomMargin = 80;
        root.addView(progress, pp);

        status = new TextView(this);
        status.setText("正在启动本地服务…");
        status.setTextSize(14);
        status.setTextColor(Color.rgb(90, 100, 115));
        status.setGravity(Gravity.CENTER);
        FrameLayout.LayoutParams sp = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER);
        sp.bottomMargin = -80;
        root.addView(status, sp);

        setContentView(root);
        webView.loadDataWithBaseURL(null,
            "<html><body style='margin:0;background:#f5f5f7'></body></html>",
            "text/html", "utf-8", null);

        requestStorageAccess();
        try {
            if (!Python.isStarted()) Python.start(new AndroidPlatform(this));
            startBackend();
        } catch (Throwable t) {
            showError("Python 启动失败：\n" + t);
        }
    }

    private void requestStorageAccess() {
        if (Build.VERSION.SDK_INT >= 30) {
            if (!Environment.isExternalStorageManager()) {
                new AlertDialog.Builder(this)
                    .setTitle("需要文件访问权限")
                    .setMessage("为了读写手机上的模组文件，请允许“所有文件访问”。\n\n如果不授权，仍可使用内部示例空间，但资源管理器看不到 RTmod。")
                    .setPositiveButton("去授权", (d, i) -> {
                        try {
                            Intent it = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                                Uri.parse("package:" + getPackageName()));
                            startActivity(it);
                        } catch (Exception e) {
                            startActivity(new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION));
                        }
                    })
                    .setNegativeButton("稍后", null)
                    .show();
            }
        } else if (Build.VERSION.SDK_INT >= 23) {
            requestPermissions(new String[]{
                android.Manifest.permission.READ_EXTERNAL_STORAGE,
                android.Manifest.permission.WRITE_EXTERNAL_STORAGE
            }, 10);
        }
    }

    private void startBackend() {
        new Thread(() -> {
            try {
                File base = new File(getFilesDir(), "rtcoder");
                File staticDir = new File(base, "static");
                File dataDir = new File(base, "data");
                File outputDir = chooseOutputDir();
                copyBundledAssets(base, staticDir, dataDir);

                Python py = Python.getInstance();
                String modRoot = chooseModRoot();
                py.getModule("rt_server").callAttr("start",
                    base.getAbsolutePath(), dataDir.getAbsolutePath(),
                    outputDir.getAbsolutePath(), modRoot, PORT);

                boolean ok = false;
                for (int i = 0; i < 80; i++) {
                    if (isHealthy()) { ok = true; break; }
                    Thread.sleep(250);
                }
                final boolean ready = ok;
                runOnUiThread(() -> {
                    if (ready) {
                        progress.setVisibility(View.GONE);
                        status.setVisibility(View.GONE);
                        webView.loadUrl("http://127.0.0.1:" + PORT + "/");
                    } else {
                        showError("本地服务启动超时。\n请确认应用有存储权限后重试。");
                    }
                });
            } catch (Throwable t) {
                runOnUiThread(() -> showError("启动失败：\n" + t));
            }
        }, "rtcoder-start").start();
    }

    private void showError(String msg) {
        if (progress != null) progress.setVisibility(View.GONE);
        if (status != null) {
            status.setText(msg + "\n\n可尝试重新打开应用。");
            status.setTextSize(13);
        }
    }

    private File chooseOutputDir() {
        if (Build.VERSION.SDK_INT < 30 || Environment.isExternalStorageManager()) {
            File out = new File(Environment.getExternalStorageDirectory(), "RTCoder/output");
            if (out.exists() || out.mkdirs()) return out;
        }
        File out = new File(getFilesDir(), "rtcoder/output");
        out.mkdirs();
        return out;
    }

    private String chooseModRoot() {
        if (Build.VERSION.SDK_INT >= 30 && !Environment.isExternalStorageManager()) {
            return new File(getFilesDir(), "rtcoder").getAbsolutePath();
        }
        String[] candidates = {
            "/storage/emulated/0/RTmod",
            "/storage/emulated/0/Download/RTmod",
            "/storage/emulated/0"
        };
        for (String c : candidates) {
            if (new File(c).isDirectory()) return c;
        }
        return Environment.getExternalStorageDirectory().getAbsolutePath();
    }

    private void copyBundledAssets(File base, File staticDir, File dataDir) {
        try {
            base.mkdirs();
            staticDir.mkdirs();
            dataDir.mkdirs();
            copyAssetDir("rtcoder/static", staticDir);
            copyAssetFile("rtcoder/data/code_table.json", new File(dataDir, "code_table.json"), true);
            copyAssetFile("rtcoder/data/backpack.json", new File(dataDir, "backpack.json"), false);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    private void copyAssetDir(String assetPath, File dest) throws Exception {
        String[] children = getAssets().list(assetPath);
        if (children == null || children.length == 0) {
            copyAssetFile(assetPath, dest, true);
            return;
        }
        dest.mkdirs();
        for (String name : children) {
            copyAssetDir(assetPath + "/" + name, new File(dest, name));
        }
    }

    private void copyAssetFile(String assetPath, File dest, boolean overwrite) throws Exception {
        if (dest.exists() && !overwrite) return;
        File parent = dest.getParentFile();
        if (parent != null) parent.mkdirs();
        try (InputStream in = getAssets().open(assetPath);
             OutputStream out = new FileOutputStream(dest)) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
    }

    private boolean isHealthy() {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL("http://127.0.0.1:" + PORT + "/api/health").openConnection();
            c.setConnectTimeout(700);
            c.setReadTimeout(700);
            c.setRequestMethod("GET");
            return c.getResponseCode() == 200;
        } catch (Exception e) {
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
        }
        super.onDestroy();
    }
}
