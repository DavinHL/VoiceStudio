/**
 * Save As in a plain browser tab (no `window.voicestudio` bridge).
 *
 * Regression guard for "Save as does nothing in the web build": the control
 * used to render `disabled` whenever `getBridge()` was null, and `saveExport`
 * returned null instead of downloading. This smoke drives the real renderer
 * against the mocked API, clicks the control, and asserts Chromium actually
 * received a download with real bytes.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMockedPage, launchSmokeBrowser } from './smoke-api-mock.mjs';

const UI = process.env.VOICESTUDIO_UI_URL || 'http://localhost:3912';
const SCREENSHOT = process.env.VOICESTUDIO_SCREENSHOT;

const PROFILE = {
  id: 'vc-save',
  name: 'Save Voice',
  kind: 'clone',
  ref_audio_path: 'smoke-ref.wav',
  ref_text: 'smoke reference',
  language: 'en',
  created_at: 1,
  is_locked: false,
  vd_states: null,
  instruct: null,
  seed: null,
  personality: null,
};

const WAV = Buffer.from('RIFF____WAVEfmt ');

const browser = await launchSmokeBrowser({ fallbackChannel: 'chrome' });
const downloads = await mkdtemp(join(tmpdir(), 'vs-save-as-'));
try {
  const page = await openMockedPage(browser, {
    viewport: { width: 1400, height: 900 },
    fixtures: {
      '/api/engines': {
        active_tts: 'omnivoice',
        active_tts_ready: true,
        tts: {
          active: 'omnivoice',
          backends: [
            {
              id: 'omnivoice',
              display_name: 'OmniVoice',
              available: true,
              supports_cloning: true,
              supports_voice_conversion: false,
              routing_status: 'accelerated',
            },
          ],
        },
      },
      '/api/profiles': [PROFILE],
      '/api/history': [],
    },
    handle(route, request) {
      const { pathname } = new URL(request.url());
      if (pathname === '/api/convert') {
        return route.fulfill({
          json: {
            id: 'done0001',
            audio_url: '/audio/done0001.wav',
            text: '',
            duration_s: 1.5,
            gen_time_s: 1.2,
            engine: 'omnivoice',
          },
        });
      }
      // The renderer fetches the backend URL itself in the browser fallback.
      if (pathname.endsWith('/audio/done0001.wav')) {
        return route.fulfill({ status: 200, contentType: 'audio/wav', body: WAV });
      }
      return false;
    },
  });

  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(`${UI}/#/voice-changer`);
  await page.getByRole('heading', { name: 'Voice changer', exact: true }).first().waitFor();

  // This is only the web-build case if there is genuinely no preload bridge.
  assert.equal(
    await page.evaluate(() => Boolean(window.voicestudio)),
    false,
    'expected a browser tab with no preload bridge',
  );

  await page.setInputFiles('input[type="file"]', {
    name: 'clip.wav',
    mimeType: 'audio/wav',
    buffer: WAV,
  });
  const item = page.locator('main li').filter({ hasText: 'clip.wav' }).first();
  await item.waitFor();

  await page.getByRole('button', { name: /^Convert \d+ clip/i }).click();

  // Wait for the row to finish converting, so its Save control has a URL.
  const save = item.getByRole('button', { name: /save as/i });
  await save.waitFor({ timeout: 30000 });
  await page.waitForFunction(
    () => {
      const buttons = [...document.querySelectorAll('main li button')];
      return buttons.some(
        (button) => /save as/i.test(button.getAttribute('aria-label') || '') && !button.disabled,
      );
    },
    { timeout: 30000 },
  );

  assert.equal(await save.isDisabled(), false, 'Save as must be enabled without a bridge');

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    save.click(),
  ]);
  assert.match(download.suggestedFilename(), /^clip.*\.wav$/);

  const target = join(downloads, download.suggestedFilename());
  await download.saveAs(target);
  const bytes = await readFile(target);
  assert.ok(bytes.length > 0, 'the downloaded file must not be empty');

  assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`);
  if (SCREENSHOT) await page.screenshot({ path: SCREENSHOT });
  console.log(
    `save-as-web smoke: Save as stays enabled without a bridge and downloads ${download.suggestedFilename()} (${bytes.length} bytes)`,
  );
} finally {
  await browser.close();
  await rm(downloads, { recursive: true, force: true });
}
