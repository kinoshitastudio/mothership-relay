/* ===========================================================
   Mothership — bake（共有コア）
   mothership形式JSONを「ボードで実際に綺麗に描ける」状態へ変換する。
   CLI(tools/localize-assets.js) と relay.js(/pull) の両方から使う。

   やること：
   1) svgノード … rootの width/height を node.w/h に書換（viewBox温存）＝プリスケール
      （createNodeFromSvgのframe.resizeは中身を拡大しないため、SVG側でスケールさせる）
   2) imageノード(src有) … 画像を取得→base64-SVGノードへ変換（FILL=slice / FIT=meet）
      （mainスレッドのcreateImageAsyncはlocalhost画像を読めずグレーになるため）
      - webp/avif/gif や 重い画像は sips で jpeg変換＋表示相当にダウンサンプルしてから埋め込む
        （Figmaのcreatenodefromsvgはwebp/avifを描けない＆JSON肥大を防ぐ）。切り捨てない。
   3) サイズ番兵 … 上記処理後でも limitKB を超えたら据え置き（プレースホルダ）

   冪等：既に焼き済み(プリスケール済みsvg / base64埋込) のJSONを通しても変化しない。
   =========================================================== */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');

function download(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 Mothership' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).toString();
        res.resume(); return resolve(download(next, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = []; res.on('data', (d) => chunks.push(d)); res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

const mimeOf = (name) => /\.png$/i.test(name) ? 'image/png' : /\.webp$/i.test(name) ? 'image/webp' : /\.avif$/i.test(name) ? 'image/avif' : /\.gif$/i.test(name) ? 'image/gif' : 'image/jpeg';

async function getBytes(src, imgDir) {
  if (/^https?:\/\//.test(src) && src.indexOf('localhost') < 0) {
    const buf = await download(src);
    const name = src.split('?')[0].replace(/^https?:\/\//, '').replace(/[^\w.-]+/g, '_').slice(-80);
    return { buf, name };
  }
  const m = src.split('/refs/img/')[1];
  const name = m || path.basename(src.split('?')[0]);
  const p = path.join(imgDir, name);
  if (!fs.existsSync(p)) throw new Error('local image not found: ' + p);
  return { buf: fs.readFileSync(p), name };
}

// sips（macOS標準）で jpeg変換＋最長辺を maxDim に縮小。失敗時 null（呼び出し側で原本据え置き）。
function sipsToJpeg(buf, name, maxDim, imgDir) {
  try {
    const safe = name.replace(/[^\w.]+/g, '_');
    const tin = path.join(imgDir, '_bake_in_' + safe);
    const tout = path.join(imgDir, '_bake_out_' + safe + '.jpg');
    fs.writeFileSync(tin, buf);
    execFileSync('sips', ['-Z', String(maxDim), '-s', 'format', 'jpeg', '-s', 'formatOptions', '80', tin, '--out', tout], { stdio: 'ignore' });
    const out = fs.readFileSync(tout);
    try { fs.unlinkSync(tin); fs.unlinkSync(tout); } catch (e) {}
    return out;
  } catch (e) { return null; }
}

function prescaleSvg(node) {
  if (typeof node.svg !== 'string' || !node.w || !node.h) return false;
  const before = node.svg;
  node.svg = node.svg
    .replace(/(<svg[^>]*?)\swidth="[0-9.]+"/, '$1 width="' + node.w + '"')
    .replace(/(<svg[^>]*?)\sheight="[0-9.]+"/, '$1 height="' + node.h + '"');
  return node.svg !== before;
}

async function bake(json, opts = {}) {
  const rootDir = opts.rootDir || path.resolve(__dirname, '..');
  const imgDir = path.join(rootDir, 'refs', 'img');
  const limitKB = opts.limitKB || 300;
  fs.mkdirSync(imgDir, { recursive: true });
  const log = opts.log || (() => {});
  const stats = { prescaled: 0, embedded: 0, cut: 0, failed: 0 };

  async function walk(node) {
    const kids = node.children;
    if (!Array.isArray(kids)) return;
    for (let i = 0; i < kids.length; i++) {
      const ch = kids[i];
      if (ch.type === 'svg') { if (prescaleSvg(ch)) stats.prescaled++; }
      else if (ch.type === 'image' && typeof ch.src === 'string' && ch.src) {
        try {
          let { buf, name } = await getBytes(ch.src, imgDir);
          const cache = path.join(imgDir, name); if (!fs.existsSync(cache)) fs.writeFileSync(cache, buf);
          const W = ch.w || 200, H = ch.h || 200;
          let mime = mimeOf(name);
          // webp/avif/gif は Figma が svg内で描けない → 変換。重い画像は縮小。どちらも sips で jpeg化。
          const needConvert = /image\/(webp|avif|gif)/.test(mime);
          const needResize = buf.length > 220 * 1024;
          if (needConvert || needResize) {
            const proc = sipsToJpeg(buf, name, Math.min(2 * W, 1800), imgDir);
            if (proc) { buf = proc; mime = 'image/jpeg'; log('↳ sips変換: ' + (ch.name || name) + ' → ' + (proc.length / 1024).toFixed(0) + 'KB jpeg'); }
            else if (needConvert) { log('✂ 変換不可で据え置き(' + mime + '): ' + (ch.name || name)); stats.cut++; continue; }
          }
          if (buf.length > limitKB * 1024) { log('✂ over-limit, kept placeholder: ' + (ch.name || name)); stats.cut++; continue; }
          const par = (ch.scaleMode === 'FIT') ? 'xMidYMid meet' : 'xMidYMid slice';
          const b64 = buf.toString('base64');
          kids[i] = { type: 'svg', name: ch.name || name, x: ch.x, y: ch.y, w: W, h: H,
            svg: '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg"><image width="' + W + '" height="' + H + '" preserveAspectRatio="' + par + '" href="data:' + mime + ';base64,' + b64 + '"/></svg>' };
          log('🖼 baked: ' + (ch.name || name) + ' (' + (buf.length / 1024).toFixed(0) + 'KB ' + mime + ')');
          stats.embedded++;
        } catch (e) { log('✗ ' + (ch.name || ch.src) + ' : ' + (e && e.message ? e.message : e)); stats.failed++; }
      }
      await walk(ch);
    }
  }
  if (json.root && json.root.type === 'svg') { if (prescaleSvg(json.root)) stats.prescaled++; }
  await walk(json.root || json);
  return stats;
}

module.exports = { bake, prescaleSvg };
