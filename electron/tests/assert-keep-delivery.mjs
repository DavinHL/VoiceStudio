// Assert the "Keep my delivery" switch is ENABLED against the real backend.
//
// Two environment traps make this fail for reasons that have nothing to do with
// the engine, so both are handled explicitly:
//   1. SetupGate reads localStorage before rendering children — a fresh context
//      lands on the first-run wizard instead of the route, so seed the flag.
//   2. Playwright's browser.newPage() shares ONE default context, so a context
//      that rendered /voice-changer before the speech-to-speech engine was
//      installed keeps a stale React Query /engines cache and still renders
//      "no installed engine". Launch a dedicated context per run so the page
//      is guaranteed to mount against the current backend state.
import { launchSmokeBrowser } from './smoke-api-mock.mjs';

const UI = process.env.VOICESTUDIO_UI_URL || 'http://localhost:3901';
const API = process.env.VOICESTUDIO_API_URL || 'http://127.0.0.1:3900';
const SETUP_COMPLETE_KEY = 'voicestudio.setup.complete.v1';

// ── Ground truth: what does the backend actually advertise right now? ────────
const engines = await (await fetch(`${API}/engines`)).json();
const vc = (engines?.tts?.backends ?? []).filter(
  (b) => b.available && b.supports_voice_conversion === true && b.routing_status !== 'unavailable',
);
console.log('backend vc-capable engines:', JSON.stringify(vc.map((b) => b.id)));
if (!vc.length) {
  console.log('RESULT: backend has NO speech-to-speech engine — nothing to assert');
  process.exit(1);
}

const browser = await launchSmokeBrowser({ fallbackChannel: 'chrome' });
try {
  // Dedicated context: no carried-over query cache or storage.
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(`${UI}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(([key]) => {
    localStorage.setItem(key, '1');
    localStorage.removeItem('voicestudio.setup.in-progress.v1');
  }, [SETUP_COMPLETE_KEY]);

  await page.goto(`${UI}/#/voice-changer`, { waitUntil: 'load' });
  await page.getByRole('heading', { level: 2, name: /voice changer/i }).waitFor({ timeout: 30_000 });

  // The switch's disabled state is derived from `engines.data`, which arrives
  // asynchronously. Sampling immediately after the heading paints reads the
  // pre-fetch render, where `canKeepDelivery` is still false. Wait for the
  // engines response to land instead of guessing a fixed delay.
  await page.waitForResponse(
    (r) => /\/api\/engines(\?|$)/.test(r.url()) && r.status() === 200,
    { timeout: 30_000 },
  ).catch(() => console.log('note: no /api/engines response observed in time'));
  // React Query still has to commit the fetch into a render.
  await page.waitForFunction(
    () => {
      const sw = document.querySelector('[role="switch"]');
      if (!sw) return false;
      return sw.getAttribute('aria-disabled') !== 'true';
    },
    undefined,
    { timeout: 30_000 },
  ).catch(() => console.log('note: switch never became enabled within 30s'));

  const sw = page.locator('[role="switch"]').first();
  const ariaDisabled = await sw.getAttribute('aria-disabled');
  const contextText = await sw.evaluate((node) => {
    const label = node.closest('label') || node.parentElement;
    return label ? label.innerText.replace(/\s+/g, ' ').slice(0, 160) : '';
  });
  console.log('switch aria-disabled:', ariaDisabled);
  console.log('switch context      :', JSON.stringify(contextText));

  const enabled = ariaDisabled !== 'true';
  console.log(enabled
    ? 'RESULT: ENABLED — the UI offers "Keep my delivery"'
    : 'RESULT: DISABLED — the UI still hides "Keep my delivery"');

  if (process.env.VOICESTUDIO_SCREENSHOT) {
    await page.screenshot({ path: process.env.VOICESTUDIO_SCREENSHOT, animations: 'disabled' });
    console.log('screenshot:', process.env.VOICESTUDIO_SCREENSHOT);
  }
  if (!enabled) process.exitCode = 1;

  await context.close();
} finally {
  await browser.close();
}
