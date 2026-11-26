package app.takar.pos;

import android.content.pm.PackageManager;

import com.google.androidbrowserhelper.trusted.TwaLauncher;

/**
 * Opens the POS in Chrome whenever the tablet has it, whatever the default browser is. Left to the library, the app
 * opens in the default browser: on Galaxy tablets that is Samsung Internet, which darkens pages in dark mode and
 * (as 27) runs a Chromium 125 engine. Without Chrome the library picks a browser as before.
 */
public class LauncherActivity extends com.google.androidbrowserhelper.trusted.LauncherActivity {
  private static final String CHROME = "com.android.chrome";

  @Override
  protected TwaLauncher createTwaLauncher() {
    return new TwaLauncher(this, chromeEnabled() ? CHROME : null);
  }

  private boolean chromeEnabled() {
    try {
      return getPackageManager().getApplicationInfo(CHROME, 0).enabled;
    } catch (PackageManager.NameNotFoundException e) {
      return false;
    }
  }
}
