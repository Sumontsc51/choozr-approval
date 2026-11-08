/*
 * AI core — built-in learning model shared by the Chrome extension and the app.
 * (Keep extension/ai-core.js and mobile-app/src/aiCore.js identical to this file:
 *  `npm run sync` in the repo root copies it.)
 *
 * Every Choozr measurement is computed from the points the coordinator places, so a
 * misplaced point shows up as a measurement out of proportion with the rest of the body.
 * The model learns, from APPROVED orders only, the normal proportion between every pair
 * of measurements (log space, Welford running mean/variance). For a new export it scores
 * each measurement by the median z-score of its pairs: a wrong measurement is off against
 * all partners; a correct one only against the single wrong partner.
 *
 * It also learns from REJECTIONS: measurements named in reject reasons and measurements
 * changed between a rejected and the next approved version get a stricter threshold.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.AICore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function round(n) { return Math.round(n * 100) / 100; }

  /** "95.10 cm", "37.44 in", "5' 10\"", "5 ft 10 in" -> centimetres (or null). */
  function toCm(value) {
    var v = String(value || '').trim().toLowerCase().replace(',', '.');
    var m;
    if ((m = v.match(/^(\d+(?:\.\d+)?)\s*cm$/))) return round(parseFloat(m[1]));
    if ((m = v.match(/^(\d+(?:\.\d+)?)\s*mm$/))) return round(parseFloat(m[1]) / 10);
    if ((m = v.match(/^(\d+)\s*(?:'|ft|feet)\s*(\d+(?:\.\d+)?)?\s*(?:"|in|inch|inches|'')?$/)))
      return round(parseInt(m[1], 10) * 30.48 + (m[2] ? parseFloat(m[2]) * 2.54 : 0));
    if ((m = v.match(/^(\d+(?:\.\d+)?)\s*(?:"|in|inch|inches)$/))) return round(parseFloat(m[1]) * 2.54);
    if ((m = v.match(/^(\d+(?:\.\d+)?)$/))) return round(parseFloat(m[1]));
    return null;
  }

  function keyOf(name) { return String(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  function pairKey(a, b) { return a < b ? a + '|' + b : b + '|' + a; }
  function usable(ms) {
    return (ms || []).filter(function (m) { return m.cm !== null && m.cm !== undefined && m.cm > 0; })
      .map(function (m) { return { key: keyOf(m.name), label: m.name, cm: m.cm }; });
  }
  function emptyStats() { return { approved: 0, rejected: 0, pairs: {}, names: {} }; }
  function nameStat(s, key, label) {
    if (!s.names[key]) s.names[key] = { label: label, seen: 0, mentioned: 0, corrected: 0, corrPctSum: 0 };
    return s.names[key];
  }
  function push(r, x) {
    var s = r || { n: 0, mean: 0, m2: 0 };
    var n = s.n + 1, d = x - s.mean, mean = s.mean + d / n;
    return { n: n, mean: mean, m2: s.m2 + d * (x - mean) };
  }

  /** Learn normal proportions from an approved order. */
  function learnApproved(s, ms) {
    var u = usable(ms);
    s.approved++;
    u.forEach(function (m) { nameStat(s, m.key, m.label).seen++; });
    for (var i = 0; i < u.length; i++) {
      for (var j = i + 1; j < u.length; j++) {
        var a = u[i].key < u[j].key ? u[i] : u[j];
        var b = u[i].key < u[j].key ? u[j] : u[i];
        var k = pairKey(a.key, b.key);
        s.pairs[k] = push(s.pairs[k], Math.log(a.cm / b.cm));
      }
    }
    return s;
  }

  var STOP = { length: 1, girth: 1, width: 1, line: 1, point: 1, points: 1, the: 1, and: 1, high: 1, low: 1, upper: 1, lower: 1, front: 1, back: 1, side: 1, view: 1 };
  function mentionedIn(reason, ms) {
    var r = ' ' + String(reason || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' ';
    var hit = [];
    (ms || []).forEach(function (m) {
      var words = keyOf(m.name).split(' ').filter(function (w) { return w.length >= 3 && !STOP[w]; });
      if (words.some(function (w) { return r.indexOf(' ' + w + ' ') >= 0 || r.indexOf(' ' + w + 's ') >= 0; })) hit.push(m.name);
    });
    return hit;
  }

  /** Learn from a rejection: which measurements the approver complained about. */
  function learnRejected(s, ms, reason) {
    s.rejected++;
    var hits = reason ? mentionedIn(reason, ms) : [];
    hits.forEach(function (name) { nameStat(s, keyOf(name), name).mentioned++; });
    return hits;
  }

  /** Learn from rework: measurements that changed between the rejected and the approved version. */
  function learnCorrection(s, rejected, approved) {
    var before = {};
    usable(rejected).forEach(function (m) { before[m.key] = m; });
    var out = [];
    usable(approved).forEach(function (a) {
      var b = before[a.key];
      if (!b) return;
      var pct = Math.abs(a.cm - b.cm) / b.cm * 100;
      if (pct >= 1) {
        var ns = nameStat(s, a.key, a.label);
        ns.corrected++;
        ns.corrPctSum += pct;
        out.push({ name: a.label, fromCm: b.cm, toCm: a.cm, pct: Math.round(pct * 10) / 10 });
      }
    });
    return out;
  }

  /** 0..1 — how often this measurement has been wrong historically. */
  function risk(s, key) {
    var ns = s.names[key];
    if (!ns) return 0;
    var total = Math.max(1, s.approved + s.rejected);
    return Math.min(1, (ns.corrected + 0.5 * ns.mentioned) / total * 4);
  }

  // Very wide cold-start sanity ranges (ratio to height) used until enough approvals exist.
  var SANITY = [
    [/neck/, 0.17, 0.32], [/bust|chest/, 0.42, 0.95], [/waist/, 0.33, 0.95], [/seat|hip/, 0.42, 1.0],
    [/thigh/, 0.22, 0.6], [/calf/, 0.15, 0.35], [/wrist/, 0.07, 0.14], [/inseam/, 0.36, 0.53],
    [/outseam/, 0.5, 0.7], [/shoulder width|back shoulder/, 0.17, 0.33], [/bicep|upper ?arm girth|upperarm/, 0.13, 0.32],
  ];

  /** Scores an export. Returns { issues, flags, scores, learned, note }. */
  function check(s, ms, minSamples) {
    s = s || emptyStats();
    minSamples = minSamples || 15;
    var u = usable(ms), issues = [], flags = {}, scores = {}, learned = false;

    u.forEach(function (m) {
      var zs = [];
      u.forEach(function (o) {
        if (o.key === m.key) return;
        var st = s.pairs[pairKey(m.key, o.key)];
        if (!st || st.n < minSamples) return;
        var sd = Math.max(0.015, Math.sqrt(st.m2 / (st.n - 1)));
        var x = m.key < o.key ? Math.log(m.cm / o.cm) : Math.log(o.cm / m.cm);
        zs.push(Math.abs((x - st.mean) / sd));
      });
      if (zs.length < 3) return;
      learned = true;
      zs.sort(function (a, b) { return a - b; });
      var med = zs[Math.floor(zs.length / 2)];
      scores[m.label] = Math.round(med * 100) / 100;
      var r = risk(s, m.key), thr = 3 - r;
      if (med > thr) {
        var sev = med > thr * 2 ? 'high' : med > thr * 1.4 ? 'medium' : 'low';
        issues.push({ measurement: m.label, view: 'unknown', severity: sev, source: 'stats',
          problem: 'Out of proportion with the rest of the body (' + med.toFixed(1) + 'σ vs ' + s.approved + ' approved orders)' + (r > 0.3 ? ' · often corrected before' : '') });
        flags[m.label] = med.toFixed(1) + 'σ';
      }
    });

    if (!learned) {
      var h = u.filter(function (m) { return m.key === 'height'; })[0];
      if (h) {
        u.forEach(function (m) {
          if (m === h) return;
          var rng = SANITY.filter(function (x) { return x[0].test(m.key); })[0];
          if (!rng) return;
          var ratio = m.cm / h.cm;
          if (ratio < rng[1] || ratio > rng[2]) {
            issues.push({ measurement: m.label, view: 'unknown', severity: 'high', source: 'stats',
              problem: 'Implausible for a ' + h.cm + ' cm tall person (' + m.cm + ' cm). Point probably misplaced.' });
            flags[m.label] = 'implausible';
          }
        });
      }
    }
    var note = learned
      ? 'Proportion model trained on ' + s.approved + ' approved orders.'
      : 'Proportion model still learning (' + s.approved + '/' + minSamples + ' approved orders); only gross errors are checked.';
    return { issues: issues, flags: flags, scores: scores, learned: learned, note: note };
  }

  /** Combines the built-in result with an optional Claude review into the stored `ai` object. */
  function combine(st, claude, forVersion, model) {
    var issues, flags = Object.assign({}, st.flags), verdict, score, summary, engines = ['built-in'];
    if (claude) {
      engines.push('claude');
      verdict = claude.verdict;
      summary = claude.summary;
      var named = {};
      claude.issues.forEach(function (i) { named[i.measurement.toLowerCase()] = 1; flags[i.measurement] = i.severity; });
      issues = claude.issues.concat(st.issues.filter(function (i) { return !named[i.measurement.toLowerCase()]; }));
      if (verdict === 'ok' && st.issues.some(function (i) { return i.severity === 'high'; })) {
        verdict = 'check';
        summary += ' (Proportion model disagrees — look at the flagged measurement.)';
      }
      var c = claude.confidence;
      score = verdict === 'ok' ? Math.round(60 + 40 * c) : verdict === 'check' ? Math.round(55 - 25 * c) : Math.round(30 - 30 * c);
    } else {
      var high = st.issues.some(function (i) { return i.severity === 'high'; });
      verdict = high ? 'wrong' : st.issues.length ? 'check' : 'ok';
      score = high ? 15 : st.issues.length ? 45 : st.learned ? 85 : 65;
      issues = st.issues;
      summary = st.issues.length ? st.issues.length + ' measurement(s) out of normal proportion. ' + st.note : 'No proportion problems found. ' + st.note;
    }
    return {
      status: 'done', forVersion: forVersion, verdict: verdict, score: score, summary: summary,
      issues: issues.slice(0, 12), flags: flags, engines: engines, model: claude ? model : 'built-in',
      at: new Date().toISOString(),
    };
  }

  /** Which kind of lesson (for the Claude playbook) a decision teaches, or null. */
  function lessonKind(decision, ai, hadRejectedBefore) {
    if (decision === 'approved' && hadRejectedBefore) return 'fixed';
    if (decision === 'rejected' && ai && ai.status === 'done' && ai.verdict === 'ok') return 'missed';
    if (decision === 'approved' && ai && ai.status === 'done' && ai.verdict !== 'ok' && (ai.issues || []).length) return 'false_alarm';
    return null;
  }

  return {
    toCm: toCm, keyOf: keyOf, emptyStats: emptyStats, learnApproved: learnApproved, learnRejected: learnRejected,
    learnCorrection: learnCorrection, mentionedIn: mentionedIn, risk: risk, check: check, combine: combine, lessonKind: lessonKind,
  };
});
