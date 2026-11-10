// Intercept the exact module the page imports, to see what useEngines returns.
import { launchSmokeBrowser } from './smoke-api-mock.mjs';

const UI = process.env.VOICESTUDIO_UI_URL || 'http://localhost:3901';
const SETUP_COMPLETE_KEY = 'voicestudio.setup.complete.v1';

const browser = await launchSmokeBrowser({ fallbackChannel: 'chrome' });
try {
  const context = await browser.newContext();
  const page = await context.newPage();

  // Count how many times the engines endpoint is hit and with what result.
  const hits = [];
  page.on('response', async (r) => {
    if (!/\/api\/engines(\?|$)/.test(r.url())) return;
    try {
      const j = await r.json();
      const vc = (j?.tts?.backends ?? []).filter((b) => b.supports_voice_conversion === true);
      hits.push({ status: r.status(), vc: vc.map((b) => `${b.id}:${b.available}:${b.routing_status}`) });
    } catch { hits.push({ status: r.status(), vc: 'unparsed' }); }
  });

  await page.goto(`${UI}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(([k]) => {
    localStorage.setItem(k, '1');
    localStorage.removeItem('voicestudio.setup.in-progress.v1');
  }, [SETUP_COMPLETE_KEY]);

  await page.goto(`${UI}/#/voice-changer`, { waitUntil: 'load' });
  await page.getByRole('heading', { level: 2, name: /voice changer/i }).waitFor({ timeout: 30_000 });
  await page.waitForTimeout(7000);

  console.log('engines hits:', JSON.stringify(hits));

  // What does the rendered page think? Read the hint paragraph next to the switch.
  const nearSwitch = await page.locator('[role="switch"]').first()
    .evaluate((n) => {
      const label = n.closest('label') || n.parentElement;
      return label ? label.innerText.replace(/\s+/g, ' ') : '';
    });
  console.log('switch label text:', JSON.stringify(nearSwitch));

  // And the explanatory paragraph further down (line ~311 fallback).
  const body = await page.locator('body').innerText();
  const idx = body.indexOf('speech to speech');
  if (idx >= 0) console.log('body mentions:', JSON.stringify(body.slice(Math.max(0, idx - 90), idx + 90).replace(/\s+/g, ' ')));

  await context.close();
} finally {
  await browser.close();
}
