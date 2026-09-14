// 扫描 examples/samples 里的日志是否会泄露个人标识（开源前检查）
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const files = execSync('git ls-files samples', { cwd: REPO }).toString().trim().split('\n').filter(Boolean);
const patterns = [
  [/ProfileId[:=]\s*([0-9a-f]+)/gi, 'ProfileId'],
  [/AccountId[:=]\s*([0-9a-f]+)/gi, 'AccountId'],
  [/Nickname[:=]\s*(\S+)/gi, 'Nickname'],
  [/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, 'IP'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'email'],
  [/token["':=\s]+([A-Za-z0-9._-]{20,})/gi, 'token'],
];
for (const f of files) {
  const full = path.join(REPO, f);
  const st = fs.statSync(full);
  if (st.size > 5 * 1024 * 1024) { console.log(`${f}: ${(st.size / 1024).toFixed(0)}KB (binary/大文件，跳过文本扫描)`); continue; }
  let txt = '';
  try { txt = fs.readFileSync(full, 'utf8'); } catch { console.log(`${f}: 非文本`); continue; }
  const hits = new Map();
  for (const [re, name] of patterns) {
    for (const m of txt.matchAll(re)) {
      const v = m[1] || m[0];
      const key = name + '=' + v;
      hits.set(key, (hits.get(key) || 0) + 1);
    }
  }
  console.log(`\n${f} (${(st.size / 1024).toFixed(0)}KB)`);
  if (!hits.size) console.log('  ✓ 未发现个人标识');
  for (const [k, n] of hits) console.log(`  ⚠ ${k}  x${n}`);
}
