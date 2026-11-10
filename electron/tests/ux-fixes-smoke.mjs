/**
 * Voice Changer — the three reported UX defects, checked in a real browser:
 *   1. Stop must stay clickable while a take is recording.
 *   2. A finished take must be reviewable before it is converted.
 *   3. The chosen target voice must be stated, and each voice auditionable.
 *
 * Local fork addition. Runs against the mocked smoke server like
 * voice-changer-smoke.mjs, but Chromium is launched with a synthetic
 * microphone so the real `useRecording` hook drives the record/stop path
 * instead of a stub.
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { openMockedPage } from './smoke-api-mock.mjs';

const UI = process.env.VOICESTUDIO_UI_URL || 'http://localhost:3912';

const PROFILE = {
  id: 'vc-ux',
  name: 'Ux Voice',
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
};

// A synthetic capture device is what makes this a real test of the recorder:
// without it getUserMedia rejects and the Stop control never renders.
const browser = await chromium.launch({
  channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

try {
  const page = await openMockedPage(browser, {
    viewport: { width: 1400, height: 900 },
    fixtures: {
      '/api/engines': {
        tts: { backends: [], active: null },
        active_tts: null,
        asr: { backends: [], active: null },
      },
      '/api/profiles': [PROFILE],
      '/api/history': [],
    },
  });

  await page.goto(`${UI}/#/voice-changer`);
  await page.getByRole('heading', { name: 'Voice changer', exact: true }).first().waitFor();

  // 3. The target-voice pane names the destination and offers an audition button.
  const target = page.locator('section[aria-label="Target voice"]');
  await target.waitFor();
  assert.match(await target.innerText(), /Converting into Ux Voice/i);
  assert.equal(
    await target.locator('button[aria-pressed="true"]').count(),
    1,
    'exactly one voice reads as selected',
  );

  // 1. A take records and Stop stays enabled throughout.
  const record = page.getByRole('button', { name: 'Record a clip', exact: true }).first();
  await record.click();
  const stop = page.getByRole('button', { name: 'Stop recording', exact: true }).first();
  await stop.waitFor({ timeout: 25000 });
  assert.equal(await stop.isDisabled(), false, 'Stop must be clickable while recording');
  await page.waitForTimeout(900);
  assert.equal(await stop.isDisabled(), false, 'Stop must stay clickable during the take');
  await stop.click();

  // 2. The finished take lands in a review panel, not straight in the queue.
  const review = page.locator('section[aria-label="Review your recording"]');
  await review.waitFor({ timeout: 30000 });
  assert.equal(await page.locator('main li').count(), 0, 'a take must not queue before review');

  const addToQueue = review.getByRole('button', { name: 'Add to queue' });
  const recordAgain = review.getByRole('button', { name: 'Record again' });
  const discard = review.getByRole('button', { name: 'Discard' });
  for (const button of [addToQueue, recordAgain, discard]) await button.waitFor();

  await addToQueue.click();
  await page.locator('main li').first().waitFor({ timeout: 15000 });
  assert.equal(await review.count(), 0, 'reviewing is over once the take joins the queue');

  console.log(
    'ux-fixes smoke: Stop clickable while recording, take reviewed before queueing, target voice stated',
  );
} finally {
  await browser.close();
}
