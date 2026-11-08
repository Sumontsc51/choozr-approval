/*
 * Optional Claude vision reviewer + playbook learner (runs in the extension service worker
 * on the coordinator's PC, so the API key never leaves that PC).
 */
(function (root) {
  const SYSTEM = `You are a senior body-measurement QA specialist for a made-to-measure clothing company.
Coordinators place measurement points/lines on customer photos in the Choozr editor (front view and side view).
Choozr computes each measurement from those lines. Decide whether the VALIDATED measurement lines are placed correctly.

General standards (the PLAYBOOK below overrides these when they conflict):
- Height: top marker at the top of the head (not hair volume), bottom marker at the bottom of the heel.
- Girth lines lie on the body outline at the correct anatomical level, horizontal unless anatomy dictates otherwise,
  endpoints touching the body edges (not loose clothing far from the skin, not background, not arms).
- Bust/chest at fullest point; natural waist at the narrowest point of the torso; upper hip between waist and seat;
  seat/hip at the fullest point of the buttocks (check the SIDE view); thigh just below the crotch.
- Lengths follow anatomical landmarks (shoulder tip, elbow, wrist bone, crotch, ankle).
- Side and front view must agree on the level of each girth.
- Loose clothing, arms covering the torso or poor photos -> "check", not automatically "wrong".
Only judge measurements in the validated list. Be specific (measurement, view, what is wrong). Don't invent problems.`;

  const REVIEW_TOOL = {
    name: 'report_review',
    description: 'Report the QA verdict for this measurement export.',
    input_schema: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['ok', 'check', 'wrong'] },
        confidence: { type: 'number', description: '0..1' },
        summary: { type: 'string', description: 'One or two sentences for the approver.' },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              measurement: { type: 'string' },
              view: { type: 'string', enum: ['front', 'side', 'both', 'unknown'] },
              severity: { type: 'string', enum: ['low', 'medium', 'high'] },
              problem: { type: 'string', description: 'What is wrong and how to fix it, max 25 words.' },
            },
            required: ['measurement', 'view', 'severity', 'problem'],
          },
        },
      },
      required: ['verdict', 'confidence', 'summary', 'issues'],
    },
  };
  const PLAYBOOK_TOOL = {
    name: 'update_playbook',
    description: 'Return the complete updated playbook.',
    input_schema: {
      type: 'object',
      properties: {
        lesson: { type: 'string', description: 'One sentence: what was learned from this case.' },
        rules: {
          type: 'array', maxItems: 40,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' }, rule: { type: 'string' }, measurement: { type: 'string' },
              view: { type: 'string', enum: ['front', 'side', 'both'] }, evidence: { type: 'number' },
            },
            required: ['id', 'rule', 'measurement', 'view', 'evidence'],
          },
        },
      },
      required: ['lesson', 'rules'],
    },
  };

  const img = (b64) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } });
  const msList = (ms) => (ms || []).map((m) => `- ${m.name}: ${m.value}`).join('\n') || '(none)';
  const rulesText = (p) => (p.rules || []).length
    ? p.rules.map((r) => `- [${r.id}] (${r.measurement}, ${r.view}, seen ${r.evidence}x) ${r.rule}`).join('\n')
    : '(empty — no lessons learned yet)';

  async function call(cfg, body) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(Object.assign({ model: cfg.model, system: SYSTEM }, body)),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('Claude: ' + ((j.error && j.error.message) || res.status));
    const block = (j.content || []).find((c) => c.type === 'tool_use');
    if (!block) throw new Error('Claude returned no structured answer');
    return block.input;
  }

  async function review(cfg, a) {
    const out = await call(cfg, {
      max_tokens: 1500,
      tools: [REVIEW_TOOL],
      tool_choice: { type: 'tool', name: REVIEW_TOOL.name },
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'FRONT VIEW:' }, img(a.front),
          { type: 'text', text: 'SIDE VIEW:' }, img(a.side),
          { type: 'text', text:
`Order #${a.orderNo}.
VALIDATED MEASUREMENTS (only these are being approved):
${msList(a.measurements)}

BUILT-IN PROPORTION MODEL FINDINGS (statistical hints, confirm visually):
${a.statsFindings || '(none)'}

PLAYBOOK — rules learned from this company's approver decisions (follow them):
${rulesText(a.playbook)}

Review the lines and call report_review.` },
        ],
      }],
    });
    return {
      verdict: ['ok', 'check', 'wrong'].includes(out.verdict) ? out.verdict : 'check',
      confidence: Math.max(0, Math.min(1, Number(out.confidence) || 0)),
      summary: String(out.summary || ''),
      issues: (out.issues || []).map((i) => ({ measurement: String(i.measurement), view: i.view || 'unknown', severity: i.severity || 'medium', problem: String(i.problem), source: 'claude' })),
    };
  }

  async function learn(cfg, a) {
    const what = {
      fixed: 'The approver REJECTED the first version; the coordinator reworked the points and the next version was APPROVED. Learn what was wrong in the rejected version and how the fix looks.',
      missed: 'The AI reviewer said the placement was OK, but the approver REJECTED it. Learn what the AI missed.',
      false_alarm: 'The AI reviewer flagged problems, but the approver APPROVED the order. Learn what NOT to flag in future, unless the concern is a real general rule the approver tolerated.',
    }[a.kind];
    const content = [];
    for (const im of a.images) { content.push({ type: 'text', text: im.label + ':' }); content.push(img(im.b64)); }
    content.push({ type: 'text', text:
`${what}

Approver's reject reason: ${a.reason || '(none given)'}
AI review at the time: ${a.aiSummary || '(none)'}
AI issues: ${(a.aiIssues || []).map((i) => `${i.measurement} (${i.view}): ${i.problem}`).join('; ') || '(none)'}
Measurements changed by the rework: ${(a.changes || []).map((c) => `${c.name} ${c.fromCm}→${c.toCm} cm (${c.pct}%)`).join('; ') || '(n/a)'}

CURRENT PLAYBOOK:
${rulesText(a.playbook)}

Update the playbook: strengthen (evidence+1) a rule this case supports, edit a rule it refines or contradicts, or add a
new general rule. Merge duplicates. Max 40 rules (drop the lowest evidence). Rules must be general and reusable,
never customer-specific. Call update_playbook.` });
    const out = await call(cfg, {
      max_tokens: 4000,
      tools: [PLAYBOOK_TOOL],
      tool_choice: { type: 'tool', name: PLAYBOOK_TOOL.name },
      messages: [{ role: 'user', content }],
    });
    const rules = (out.rules || []).slice(0, 40).map((r, i) => ({
      id: String(r.id || 'r' + (i + 1)), rule: String(r.rule), measurement: String(r.measurement || 'general'),
      view: ['front', 'side', 'both'].includes(r.view) ? r.view : 'both', evidence: Math.max(1, Math.round(Number(r.evidence) || 1)),
    }));
    return { lesson: String(out.lesson || ''), rules };
  }

  root.ClaudeAI = { review, learn };
})(typeof globalThis !== 'undefined' ? globalThis : this);
