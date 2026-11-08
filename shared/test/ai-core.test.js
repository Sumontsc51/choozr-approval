const { test } = require('node:test');
const assert = require('node:assert/strict');
const AI = require('../ai-core.js');

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());
function body(over = {}) {
  const h = 155 + rnd() * 35, size = 1 + gauss() * 0.08;
  const v = (r, sd = 0.025) => h * r * size * (1 + gauss() * sd);
  const raw = { 'Height': h, 'Neck': v(0.215), 'Bust / chest': v(0.56), 'Natural waist (high waist)': v(0.47),
    'Upper hip (low waist)': v(0.55), 'Seat': v(0.6), 'Thigh girth': v(0.34), 'Calf girth': v(0.21),
    'Inseam': h * 0.45 * (1 + gauss() * 0.02), 'Back shoulder width': h * 0.25 * (1 + gauss() * 0.03) };
  for (const [k, f] of Object.entries(over)) raw[k] *= f;
  return Object.entries(raw).map(([name, cm]) => ({ name, value: `${cm.toFixed(2)} cm`, cm: Math.round(cm * 100) / 100 }));
}

test('toCm parses Choozr formats', () => {
  assert.equal(AI.toCm('178.00 cm'), 178);
  assert.equal(AI.toCm('37.44 in'), 95.1);
  assert.equal(AI.toCm(`5' 10"`), 177.8);
  assert.equal(AI.toCm('n/a'), null);
});
test('cold start flags only gross errors', () => {
  const s = AI.emptyStats();
  assert.equal(AI.check(s, body(), 15).issues.length, 0);
  assert.ok(AI.check(s, body({ 'Natural waist (high waist)': 2.6 }), 15).issues.some((i) => i.measurement.startsWith('Natural waist')));
});
test('learned model pinpoints a single misplaced measurement', () => {
  const s = AI.emptyStats();
  for (let i = 0; i < 60; i++) AI.learnApproved(s, body());
  let fp = 0;
  for (let i = 0; i < 40; i++) fp += AI.check(s, body(), 15).issues.length;
  assert.ok(fp <= 6, `false flags ${fp}`);
  const r = AI.check(s, body({ 'Natural waist (high waist)': 1.18 }), 15);
  assert.deepEqual(r.issues.map((i) => i.measurement), ['Natural waist (high waist)']);
  const ai = AI.combine(r, null, 3, '');
  assert.equal(ai.verdict, 'check');
  assert.equal(ai.forVersion, 3);
});
test('learns from rejection + rework; JSON round-trip safe for Firestore', () => {
  const s = AI.emptyStats();
  const bad = body({ Seat: 1.15 });
  assert.deepEqual(AI.learnRejected(s, bad, 'Seat line too low in side view'), ['Seat']);
  const fixed = bad.map((m) => (m.name === 'Seat' ? { ...m, cm: m.cm / 1.15 } : m));
  assert.equal(AI.learnCorrection(s, bad, fixed)[0].name, 'Seat');
  assert.ok(AI.risk(JSON.parse(JSON.stringify(s)), 'seat') > 0.5);
  assert.equal(AI.lessonKind('approved', null, true), 'fixed');
  assert.equal(AI.lessonKind('rejected', { status: 'done', verdict: 'ok' }, false), 'missed');
});
