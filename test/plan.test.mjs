import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shape, notePlanEvent, planNow, lineOf, _reset } from '../server/plan.js';

// What the SDK's usage call answered on 27-11-2026, cut down.
const answer = {
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 18, resets_at: '2026-11-27T19:19:59.787478+00:00' },
    seven_day: { utilization: 33.4, resets_at: '2026-12-02T22:59:59.787497+00:00' },
    seven_day_opus: null,
    model_scoped: [{ display_name: 'Fable', utilization: 31, resets_at: '2026-12-02T22:59:59.787700+00:00' }],
  },
};

test('the usage answer becomes two windows and the per-model ones', () => {
  const p = shape(answer, 1000);
  assert.deepEqual(p.fiveHour, { pct: 18, resetsAt: Date.parse('2026-11-27T19:19:59.787Z') });
  assert.equal(p.week.pct, 33);
  assert.deepEqual(p.models.map((m) => [m.name, m.pct]), [['Fable', 31]]);
  assert.equal(p.plan, 'max');
  assert.equal(p.at, 1000);
});

test('no plan limits (an API key) shows nothing', () => {
  assert.equal(shape({ rate_limits_available: false, rate_limits: null }), null);
  assert.equal(shape(undefined), null);
  assert.equal(shape({ rate_limits_available: true, rate_limits: { five_hour: null, seven_day: null } }), null);
});

test('a run\'s rate-limit event updates its window', async () => {
  _reset();
  process.env.APP_AI_FAKE = '1';
  notePlanEvent({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.5 }); // nothing known yet: ignored
  assert.equal(await planNow(), null);
  delete process.env.APP_AI_FAKE;
});

test('a reading is kept as one short line', () => {
  const l = lineOf(shape(answer, 1000), 'poll');
  assert.equal(l.ts, 1000);
  assert.equal(l.src, 'poll');
  assert.deepEqual(l.h5, [18, Date.parse('2026-11-27T19:19:59.787Z')]);
  assert.equal(l.wk[0], 33);
  assert.equal(l.wk_fable[0], 31);
  assert.ok(l.host);
  assert.equal(lineOf(null, 'poll'), null);
});
