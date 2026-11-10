/**
 * Voice Changer workspace — the audio/video voice changer route.
 *
 * Local fork addition: /voice-changer drops audio or video clips, picks a saved
 * voice, and converts each clip through POST /convert. This smoke proves the
 * route mounts, the workspace exposes its voice list and the drop zone, and it
 * is reachable from the Voice group in the workspace menu.
 */
import { launchSmokeBrowser, openMockedPage } from './smoke-api-mock.mjs';
import assert from 'node:assert/strict';

const UI = process.env.VOICESTUDIO_UI_URL || 'http://localhost:3912';
const browser = await launchSmokeBrowser();

try {
  const page = await openMockedPage(browser, {
    viewport: { width: 1400, height: 900 },
    fixtures: {
      '/api/engines': {
        tts: { backends: [], active: null },
        active_tts: null,
        asr: { backends: [], active: null },
      },
      '/api/profiles': [
        {
          id: 'vc-smoke',
          name: 'Smoke Voice',
          kind: 'clone',
          ref_audio_path: 'smoke-ref.wav',
          ref_text: 'smoke reference',
          language: 'id',
          created_at: 1,
          is_locked: false,
          vd_states: null,
          instruct: null,
          seed: null,
          personality: null,
        },
      ],
      '/api/history': [],
    },
  });

  await page.goto(`${UI}/#/voice-changer`);
  await page.getByRole('heading', { name: 'Voice changer', exact: true }).first().waitFor();

  // The target-voice pane lists the saved profile and the canvas offers the drop zone.
  await page.getByRole('button', { name: /Smoke Voice/ }).waitFor();
  await page.getByRole('button', { name: /Drop audio or video here/i }).waitFor();

  // The route is reachable from the Voice group of the workspace menu.
  await page.goto(`${UI}/#/clone`);
  await page.locator('[data-slot=compact-main-sidebar], [data-slot=main-sidebar]').first().waitFor();
  const voiceGroup = page.getByRole('button', { name: 'Voice', exact: true });
  if (await voiceGroup.count()) {
    await voiceGroup.first().click();
    const link = page.getByRole('link', { name: 'Voice changer', exact: true });
    await link.waitFor();
    assert.match((await link.getAttribute('href')) ?? '', /#?\/voice-changer$/);
  }

  if (process.env.VOICESTUDIO_SCREENSHOT) {
    await page.goto(`${UI}/#/voice-changer`);
    await page.getByRole('heading', { name: 'Voice changer', exact: true }).first().waitFor();
    await page.screenshot({ path: process.env.VOICESTUDIO_SCREENSHOT, animations: 'disabled' });
  }
  console.log('voice-changer smoke: route mounts, voice list and drop zone render');
} finally {
  await browser.close();
}
