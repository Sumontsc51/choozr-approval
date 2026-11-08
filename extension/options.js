const $ = (id) => document.getElementById(id);
const msg = (el, text, ok) => { el.textContent = text; el.className = 'msg ' + (ok ? 'ok' : 'err'); };

async function refresh() {
  const u = await FB.currentUser();
  $('signedIn').style.display = u ? '' : 'none';
  $('signInForm').style.display = u ? 'none' : '';
  if (!u) return;
  $('who').textContent = u.email;
  try {
    const p = await FB.get(`users/${u.uid}`);
    const role = p?.data.role;
    $('role').innerHTML = role ? `· role: <b>${role}</b>` : '· <span class="err">no role yet — ask the admin</span>';
  } catch (e) { $('role').textContent = '· ' + e.message; }
}
$('signIn').addEventListener('click', async () => {
  try {
    msg($('authMsg'), 'Signing in…', true);
    await FB.signIn($('email').value.trim(), $('password').value);
    $('password').value = '';
    msg($('authMsg'), 'Signed in ✓', true);
    refresh();
  } catch (e) { msg($('authMsg'), e.message, false); }
});
$('signOut').addEventListener('click', async () => { await FB.signOut(); refresh(); });

chrome.storage.local.get(['claudeKey', 'claudeModel'], (v) => {
  $('claudeKey').placeholder = v.claudeKey ? 'saved (hidden) — enter a new key to replace' : 'sk-ant-…';
  $('claudeModel').value = v.claudeModel || 'claude-sonnet-5-5';
});
async function setClaudeFlag(enabled) {
  // tells the app to queue learning jobs for Claude
  try { await FB.commit([{ patch: { path: 'config/ai', data: { claudeEnabled: enabled, updatedAt: new Date() } } }]); } catch (_) {}
}
$('saveAi').addEventListener('click', async () => {
  const key = $('claudeKey').value.trim();
  const model = $('claudeModel').value.trim() || 'claude-sonnet-5-5';
  const cur = await chrome.storage.local.get('claudeKey');
  const finalKey = key || cur.claudeKey;
  if (!finalKey) return msg($('aiMsg'), 'Enter a key first', false);
  if (!/^sk-ant-/.test(finalKey)) return msg($('aiMsg'), 'That does not look like a Claude API key (sk-ant-…)', false);
  await chrome.storage.local.set({ claudeKey: finalKey, claudeModel: model });
  $('claudeKey').value = '';
  await setClaudeFlag(true);
  msg($('aiMsg'), 'Saved ✓', true);
});
$('clearAi').addEventListener('click', async () => {
  await chrome.storage.local.remove('claudeKey');
  await setClaudeFlag(false);
  msg($('aiMsg'), 'Key removed — built-in model only', true);
});
refresh();
