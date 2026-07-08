/* ===========================================================
   Mothership — アセット焼き込み（CLI）
   mothership形式JSONを「ボードで描けるJSON」へ変換して保存する。
   実体は tools/bake.js（relay /pull と共通コア）。

   使い方：
     node tools/localize-assets.js in.json --out out.json
     node tools/localize-assets.js mothership.json            # 同ファイルを更新
     node tools/localize-assets.js in.json --limit 300        # 上限KB(既定300)
   =========================================================== */
const fs = require('fs');
const path = require('path');
const { bake } = require('./bake');

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const getOpt = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const OUT = getOpt('--out', file);
const LIMIT_KB = parseInt(getOpt('--limit', '300'), 10);
if (!file) { console.error('Usage: node tools/localize-assets.js <json> [--out out.json] [--limit 300]'); process.exit(1); }

const ROOT = path.resolve(__dirname, '..');

(async () => {
  const json = JSON.parse(fs.readFileSync(path.resolve(ROOT, file), 'utf8'));
  const stats = await bake(json, { rootDir: ROOT, limitKB: LIMIT_KB, log: (m) => console.error(m) });
  fs.writeFileSync(path.resolve(ROOT, OUT), JSON.stringify(json, null, 2));
  console.error('— prescaled ' + stats.prescaled + ' / embedded ' + stats.embedded + ' / cut ' + stats.cut + ' / failed ' + stats.failed + ' → ' + OUT);
})();
