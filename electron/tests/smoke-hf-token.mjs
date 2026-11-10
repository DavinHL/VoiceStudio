/**
 * Settings → Credentials → HuggingFace token, driven against the REAL backend.
 *
 * The notification panel surfaces "HuggingFace token not set" until one of the
 * three resolver sources (app / env / hf-cli) holds a live token. The app store
 * is the only source a browser can set, so this script proves that the
 * credentials pane loads, reports all three sources, and can read and write the
 * app token through POST /api/settings/hf-token.
 *
 * Usage: node electron/tests/smoke-hf-token.mjs
 *   VOICESTUDIO_UI_URL   default http://localhost:3901
 *   VOICESTUDIO_API_URL  default http://127.0.0.1:3900
 *   VOICESTUDIO_HF_TOKEN optional — when set, the token is saved and then the
 *                        pane is asserted to report the app source as set.
 */
import { launchSmokeBrowser } from './smoke-api-mock.mjs';
import assert from 'node:assert/strict';

const UI = process.env.VOICESTUDIO_UI_URL || 'http://localhost:3901';
const API = process.env.VOICESTUDIO_API_URL || 'http://127.0.0.1:3900';
const token = (process.env.VOICESTUDIO_HF_TOKEN || '').trim();

const before = await (await fetch(`${API}/api/settings/hf-token/state`)).json();
console.log(`sources before: ${before.sources.map((s) => `${s.source}=${s.set}`).join(' ')}`);

const browser = await launchSmokeBrowser({ fallbackChannel: 'chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (error) => console.log(`[pageerror] ${String(error).slice(0, 300)}`));

  await page.addInitScript(() => {
    localStorage.setItem('voicestudio.setup.complete.v1', '1');
  });
  await page.goto(`${UI}/#/settings/credentials`);

  // The three resolver sources are listed by their stable row ids.
  for (const id of ['token-app', 'token-env', 'token-hf-cli']) {
    await page.locator(`#${id}`).first().waitFor({ timeout: 30_000 });
  }
  console.log('credentials pane rendered all three token sources');

  const input = page.locator('#hf-token-input');
  await input.waitFor();
  await page.getByRole('button', { name: /HuggingFace token/i }).first().click();
  console.log('HuggingFace token section is reachable in Settings → Credentials');

  if (token) {
    await input.fill(token);
    await input.press('Enter');
    await page.waitForTimeout(2500);
    const after = await (await fetch(`${API}/api/settings/hf-token/state`)).json();
    const app = after.sources.find((s) => s.source === 'app');
    assert.equal(app?.set, true, 'app token source should be set after saving');
    console.log(`token saved: app.set=${app.set} whoami_ok=${app.whoami_ok} user=${app.whoami_user}`);
  } else {
    console.log('VOICESTUDIO_HF_TOKEN not set — read-only verification only');
  }

  if (process.env.VOICESTUDIO_SCREENSHOT) {
    await page.screenshot({ path: process.env.VOICESTUDIO_SCREENSHOT, animations: 'disabled' });
  }
  console.log('hf-token smoke: credentials pane mounts and exposes the token form');
} finally {
  await browser.close();
}
