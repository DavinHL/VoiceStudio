/**
 * Real-backend smoke — drives the running web UI against the REAL FastAPI
 * backend (no route mocking) so a human can click through the Voice Changer
 * page with live engines, profiles and conversion.
 *
 * Usage: node electron/tests/smoke-real-backend.mjs
 *   VOICESTUDIO_UI_URL   default http://localhost:3901
 *   VOICESTUDIO_API_URL  default http://127.0.0.1:3900
 */
import { launchSmokeBrowser } from './smoke-api-mock.mjs';

const UI = process.env.VOICESTUDIO_UI_URL || 'http://localhost:3901';
const API = process.env.VOICESTUDIO_API_URL || 'http://127.0.0.1:3900';

async function probe(path) {
  try {
    const response = await fetch(`${API}${path}`);
    return { ok: response.ok, status: response.status, body: await response.text() };
  } catch (error) {
    return { ok: false, status: 0, body: String(error) };
  }
}

const health = await probe('/health');
console.log(`backend /health -> ${health.status} ${health.body.slice(0, 120)}`);
const engines = await probe('/engines');
console.log(`backend /engines -> ${engines.status} ${engines.body.slice(0, 200)}`);
const profiles = await probe('/profiles');
console.log(`backend /profiles -> ${profiles.status} ${profiles.body.slice(0, 200)}`);

const browser = await launchSmokeBrowser({ fallbackChannel: 'chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (message) => {
    if (message.type() === 'error') console.log(`[page error] ${message.text().slice(0, 300)}`);
  });
  page.on('pageerror', (error) => console.log(`[pageerror] ${String(error).slice(0, 300)}`));

  await page.addInitScript(() => {
    localStorage.setItem('voicestudio.setup.complete.v1', '1');
  });
  await page.goto(`${UI}/#/voice-changer`);
  const heading = page.getByRole('heading', { name: 'Voice changer', exact: true }).first();
  await heading.waitFor({ timeout: 30_000 });
  console.log('voice-changer heading rendered against the real backend');
  await page.getByRole('button', { name: /Drop audio or video here/i }).waitFor();
  console.log('drop zone rendered');

  // Every saved profile must be selectable as a target voice.
  const profiles = await (await fetch(`${API}/profiles`)).json();
  for (const profile of profiles) {
    const button = page.getByRole('button', { name: new RegExp(profile.name, 'i') }).first();
    await button.waitFor({ timeout: 15_000 });
  }
  console.log(`all ${profiles.length} saved voice(s) selectable: ${profiles.map((p) => p.name).join(', ')}`);

  // Freeze the page at the voice-changer workspace for a human to inspect.
  if (process.env.VOICESTUDIO_SCREENSHOT) {
    await page.screenshot({ path: process.env.VOICESTUDIO_SCREENSHOT, animations: 'disabled' });
  }
  const holdMs = Number(process.env.VOICESTUDIO_HOLD_MS || 0);
  if (holdMs > 0) await page.waitForTimeout(holdMs);
} finally {
  await browser.close();
}
