/* ============================================================
   Mothership relay — 依存ゼロのローカル中継（Node標準モジュールのみ）
   役割: mothership.json を見張り、Figmaプラグインへ配る。
   Claude Code は mothership.json を書き換えるだけ（＝MCP不要）。
   起動: node relay.js   （ポート変更: PORT=4600 node relay.js）
   ============================================================ */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { bake } = require("./tools/bake");   // svgプリスケール＋画像base64化（ボードで描ける形へ）

const FILE = path.join(__dirname, "mothership.json");
const PORT = process.env.PORT || 4575;

const read = () => { try { return fs.readFileSync(FILE, "utf8"); } catch (e) { return "{}"; } };
const ver  = () => { try { return Math.floor(fs.statSync(FILE).mtimeMs); } catch (e) { return 0; } };

// /pull で返す前に「焼き込み」（svgプリスケール／画像→base64-SVG）。版が変わった時だけ実行しキャッシュ
// （/pullは高頻度ポーリング）。失敗時・不正JSON時は素のまま返す＝壊れない。冪等なので焼済みは無処理。
let bakeCache = { v: -1, json: null };
let baking = null; // { v, promise }
async function pulledJSON() {
  const v = ver();
  if (bakeCache.v === v && bakeCache.json != null) return { version: v, json: bakeCache.json };
  if (baking && baking.v === v) return { version: v, json: await baking.promise };
  const p = (async () => {
    const raw = read();
    let obj; try { obj = JSON.parse(raw); } catch (e) { return raw; }
    try { await bake(obj, { rootDir: __dirname }); } catch (e) { return raw; }
    return JSON.stringify(obj);
  })();
  baking = { v, promise: p };
  try { const json = await p; bakeCache = { v, json }; return { version: v, json }; }
  finally { if (baking && baking.v === v) baking = null; }
}

// ブラウザのタブを使い回すためのナビ状態（新規ウィンドウを増やさない）
let navView = "", navV = 0, lastNavPoll = 0;
// チャット生成中フラグ（パネル↔大きい画面で「考えています」を同期）
let chatBusy = false, chatBusySince = 0;
let currentChild = null, aborted = false;   // 実行中プロセスを外（/abort）から止められるよう保持

// 会話ログ（relayが唯一の書き手＝どのタブに移動しても会話が消えない）
const CHATLOG = path.join(__dirname, "_chat-log.json");
const readLog = () => { try { const a = JSON.parse(fs.readFileSync(CHATLOG, "utf8")); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
const appendLog = (entry) => { try { const a = readLog(); a.push(entry); fs.writeFileSync(CHATLOG, JSON.stringify(a.slice(-60))); } catch (e) {} };

// AI整え（B）：構造JSONを渡し「整え操作リスト(JSON配列)だけ」を返させるプロンプト
const AI_TIDY_PROMPT = `あなたはFigmaレイアウト整理の専門家。渡された「Figmaフレーム構造JSON」を、プロ基準で整える【操作リスト】だけを返す。実際のノード編集はプラグインが行う＝あなたは操作を設計するだけ。

## 整えの方針
- 8ptグリッド：余白(pad)・間隔(gap)は4の倍数、基本は8の倍数(8/16/24/32…)。
- 手置きで並んだ要素はオートレイアウト化。2次元（縦積み＋横並びが混在）は【入れ子】に：横に並ぶ行(ボタン群等)は group でまとめ→その後で親を vertical の autolayout にする。**groupは親autolayoutより先に出す**。
- 背景・装飾（大きく覆う/全幅/全高の要素）は触らない（フロー外＝そのまま）。
- 既定名（"Frame 12"等）は中身のテキストから意味のある名前へ rename。
- 削除は明らかなゴミ(非表示/サイズ0)のみ。むやみに消さない。

## 出力（厳守）
**JSON配列だけ**を返す。前後に説明文・コードフェンス以外の文章を書かない。要素は次のいずれか：
[
 {"op":"rename","id":"<入力id>","name":"<新名>"},
 {"op":"group","ids":["<id>","<id>"],"name":"<名>","mode":"horizontal|vertical","gap":<数>},
 {"op":"autolayout","id":"<id>","mode":"vertical|horizontal","gap":<数>,"pad":[上,右,下,左],"align":"min|center|max"},
 {"op":"pad","id":"<id>","pad":[上,右,下,左]},
 {"op":"unifyFont","family":"<フォント名>"},
 {"op":"remove","id":"<id>"}
]
idは入力のidをそのまま使う。新規groupにidは振らない。整える点が無ければ空配列 []。`;

// AI会話編集（B拡張）：選択フレームの構造＋ユーザー指示 → 編集オペ(JSON配列)だけを返す
const AI_EDIT_PROMPT = `あなたはFigma編集の専門家。渡された「Figmaフレーム構造JSON」と「ユーザーの編集指示」から、その指示を実現する【編集操作リスト】だけを返す。実際のノード編集はプラグインが行う＝あなたは操作を設計するだけ。画像は再生成せず温存する（既存ノードを編集）。

## 方針
- ユーザー指示を忠実に実現する最小の操作を出す。指示に無い所は変えない。
- サイズ変更時は8ptグリッド（4の倍数・基本8の倍数）。レイアウトを崩さない。
- 文字色や背景色の変更は対象ノードだけ。画像塗りのノードには setFill しない。
- **★可読性を絶対に壊さない**：あなたは描画結果を見られない（構造JSONのみ）。文字色を背景と同系/近い明度にして**読めなくしない**。背景色を変えたら、その上の文字色も十分なコントラスト（明背景→濃い文字／暗背景→明るい文字）になるよう必ずセットで変える。写真の上の文字は触らない（背景不明なため）。迷ったら文字色は変えない。
- 「良い感じに」等の曖昧な指示は、**読みやすさを保ったまま**の控えめな配色/余白調整に留める（破壊的な作り直しはしない）。
- **各ノードに fill が付く＝現在の色**（#RRGGBB ／ "image"=写真・触らない ／ "gradient"）。これを見て**現在の配色を把握**し、**同系の色は一括でまとめて変える**（例：複数の赤 #e0..系を全部まとめて落ち着いた色へ）。グループ/オートレイアウトの**ネスト内の子も id で個別に setFill** できる＝深い階層の色も拾って変える。色変更は対象の **全ノード**に漏れなく出す。
- フォント変更(setFont)は **Figmaに入っているフォントしか使えない**（無い指定はInter等に代替／日本語は日本語フォントが要る）。確信が無い・できない指示は無理に実行せず、note でユーザーに伝える。
- idは入力のidをそのまま使う（ネストの深い子でもOK）。

## できない/苦手なこと（無理にやらず note で伝える）
- 全面リデザイン・要素の新規追加・画像の差し替え/生成・複雑な再構成は、この編集の範囲外（→ note で「チャットでの新規生成が向いています」等と案内）。
- 指示が曖昧/対象が特定できない時も note で確認を促す。

## 出力（厳守）
**JSONオブジェクトだけ**を返す（前後に文章を書かない）。形式：
{"ops":[ ...操作... ], "note":"<日本語の短い補足。できなかった事・代替・提案など。無ければ空文字>"}
ops に使える操作：
 {"op":"setText","id":"<id>","text":"<新しい文字>"}
 {"op":"setFontSize","id":"<id>","size":<px>}
 {"op":"setFont","id":"<id>","family":"<フォント名>","weight":<100-900の任意>}
 {"op":"setFill","id":"<id>","color":"#RRGGBB"}
 {"op":"resize","id":"<id>","w":<px>,"h":<px>}
 {"op":"setGap","id":"<id>","gap":<px>}
 {"op":"pad","id":"<id>","pad":[上,右,下,左]}
 {"op":"setRadius","id":"<id>","radius":<px>}
 {"op":"rename","id":"<id>","name":"<名>"}
 {"op":"autolayout","id":"<id>","mode":"vertical|horizontal","gap":<px>,"pad":[上,右,下,左],"align":"min|center|max"}
 {"op":"group","ids":["<id>","<id>"],"name":"<名>","mode":"horizontal|vertical","gap":<px>}
 {"op":"remove","id":"<id>"}
変える点が無ければ {"ops":[], "note":"理由や提案"}。`;

// claude -p の出力から JSON配列(ops)を取り出す（配列でも {ops:[...]} オブジェクトでも内側の[...]を拾う）
function extractOps(s) {
  let m = String(s).match(/```(?:json)?\s*([\s\S]*?)```/);
  let txt = m ? m[1] : String(s);
  const a = txt.indexOf("["), b = txt.lastIndexOf("]");
  if (a < 0 || b < 0 || b < a) return null;
  try { const p = JSON.parse(txt.slice(a, b + 1)); return Array.isArray(p) ? p : null; } catch (e) { return null; }
}
// 出力中の "note":"..." を取り出す（できなかった事・提案などのユーザー向け補足）
function extractNote(s) {
  const m = String(s).match(/"note"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (!m) return "";
  try { return JSON.parse('"' + m[1] + '"'); } catch (e) { return m[1]; }
}

http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const u = new URL(req.url, "http://x");

  // プラグインがポーリングで取りに来る（焼き込み済みを返す＝ボードで実画像/正サイズ）
  if (u.pathname === "/pull") {
    res.setHeader("Content-Type", "application/json");
    pulledJSON()
      .then((out) => res.end(JSON.stringify(out)))
      .catch(() => res.end(JSON.stringify({ version: ver(), json: read() })));
    return;
  }

  // タブ使い回し用ナビ。開いてるページが /nav を見て自分で遷移する（新規ウィンドウを増やさない）
  if (u.pathname === "/nav") {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET") { lastNavPoll = Date.now(); return res.end(JSON.stringify({ v: navV, view: navView })); }
    if (req.method === "POST") {
      let b = ""; req.on("data", (d) => (b += d));
      req.on("end", () => { try { navView = (JSON.parse(b).view || "").toString(); navV++; } catch (e) {} res.end(JSON.stringify({ ok: true, v: navV })); });
      return;
    }
  }
  if (u.pathname === "/nav-status") {
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ alive: (Date.now() - lastNavPoll) < 3000 }));
  }
  if (u.pathname === "/chat-busy") {
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ busy: chatBusy, since: chatBusySince }));
  }

  // 実行中のチャット生成（claude / 採取）を停止する
  if (u.pathname === "/abort" && req.method === "POST") {
    res.setHeader("Content-Type", "application/json");
    let killed = false;
    if (currentChild) { aborted = true; try { currentChild.kill("SIGTERM"); killed = true; } catch (e) {} }
    return res.end(JSON.stringify({ ok: true, killed: killed }));
  }

  // AI整え（B）：選択フレームの構造JSON → claude が「整え操作リスト」を返す（ファイルは編集しない）
  if (u.pathname === "/ai-tidy" && req.method === "POST") {
    let b = ""; req.on("data", (d) => (b += d));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      let structure = null;
      try { structure = JSON.parse(b).structure; } catch (e) {}
      if (!structure) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "structureが空です" })); }
      const prompt = AI_TIDY_PROMPT + "\n\n## 構造JSON\n" + JSON.stringify(structure);
      chatBusy = true; chatBusySince = Date.now();
      let done = false;
      const finish = (obj) => {
        if (done) return; done = true; chatBusy = false; currentChild = null; clearTimeout(timer);
        if (aborted) { aborted = false; return res.end(JSON.stringify({ ok: false, aborted: true })); }
        res.end(JSON.stringify(obj));
      };
      let child;
      try { child = spawn("claude", ["-p", prompt], { cwd: __dirname, stdio: ["ignore", "pipe", "pipe"] }); }
      catch (e) { return finish({ ok: false, error: "claude起動失敗: " + (e && e.message ? e.message : e) }); }
      currentChild = child;
      let out = "", err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => finish({ ok: false, error: "claudeが見つかりません: " + (e && e.message ? e.message : e) }));
      child.on("close", (code) => {
        if (code !== 0) return finish({ ok: false, error: "claude失敗: " + err.trim().slice(-300) });
        const ops = extractOps(out);
        if (!ops) return finish({ ok: false, error: "操作JSONを取り出せませんでした", raw: out.trim().slice(-300) });
        finish({ ok: true, ops: ops, note: extractNote(out) });
      });
      var timer = setTimeout(() => { try { if (currentChild) currentChild.kill(); } catch (e) {} finish({ ok: false, error: "タイムアウト（180s）" }); }, 180000);
    });
    return;
  }

  // AI会話編集（B拡張）：選択フレーム構造＋ユーザー指示 → 編集オペ。どんなフレーム（外部/手描き）も対象
  if (u.pathname === "/ai-edit" && req.method === "POST") {
    let b = ""; req.on("data", (d) => (b += d));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      let structure = null, instruction = "";
      try { const j = JSON.parse(b); structure = j.structure; instruction = (j.instruction || "").toString(); } catch (e) {}
      if (!structure) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "structureが空です" })); }
      if (!instruction.trim()) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "編集指示が空です" })); }
      const prompt = AI_EDIT_PROMPT + "\n\n## ユーザーの編集指示\n" + instruction + "\n\n## 構造JSON\n" + JSON.stringify(structure);
      chatBusy = true; chatBusySince = Date.now();
      let done = false;
      const finish = (obj) => {
        if (done) return; done = true; chatBusy = false; currentChild = null; clearTimeout(timer);
        if (aborted) { aborted = false; return res.end(JSON.stringify({ ok: false, aborted: true })); }
        res.end(JSON.stringify(obj));
      };
      let child;
      try { child = spawn("claude", ["-p", prompt], { cwd: __dirname, stdio: ["ignore", "pipe", "pipe"] }); }
      catch (e) { return finish({ ok: false, error: "claude起動失敗: " + (e && e.message ? e.message : e) }); }
      currentChild = child;
      let out = "", err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => finish({ ok: false, error: "claudeが見つかりません: " + (e && e.message ? e.message : e) }));
      child.on("close", (code) => {
        if (code !== 0) return finish({ ok: false, error: "claude失敗: " + err.trim().slice(-300) });
        const ops = extractOps(out);
        if (!ops) return finish({ ok: false, error: "操作JSONを取り出せませんでした", raw: out.trim().slice(-300) });
        finish({ ok: true, ops: ops, note: extractNote(out) });
      });
      var timer = setTimeout(() => { try { if (currentChild) currentChild.kill(); } catch (e) {} finish({ ok: false, error: "タイムアウト（180s）" }); }, 180000);
    });
    return;
  }

  // チャット履歴の共有ストア（パネルと大きい画面で会話を継続）
  if (u.pathname === "/chat-log") {
    const LOG = path.join(__dirname, "_chat-log.json");
    if (req.method === "GET") {
      res.setHeader("Content-Type", "application/json");
      try { return res.end(fs.readFileSync(LOG, "utf8")); } catch (e) { return res.end("[]"); }
    }
    if (req.method === "POST") {
      let b = ""; req.on("data", (d) => (b += d));
      req.on("end", () => { try { JSON.parse(b); fs.writeFileSync(LOG, b); res.setHeader("Content-Type", "application/json"); res.end('{"ok":true}'); } catch (e) { res.writeHead(400); res.end('{"ok":false}'); } });
      return;
    }
  }

  // 現在の mothership.json を library/ に保存（パネルの「ライブラリに保存」ボタン）
  if (u.pathname === "/save-lib" && req.method === "POST") {
    res.setHeader("Content-Type", "application/json");
    try {
      const src = read();
      const doc = JSON.parse(src);
      let name = (doc.name || (doc.root && doc.root.name) || "design").toString().trim();
      let safe = name.replace(/[\/\\:*?"<>|]+/g, "-").replace(/\s+/g, " ").slice(0, 60) || "design";
      const dir = path.join(__dirname, "library");
      try { fs.mkdirSync(dir); } catch (e) {}
      const file = "library/" + safe + ".json";
      fs.writeFileSync(path.join(__dirname, file), src);
      return res.end(JSON.stringify({ ok: true, file: file, name: name }));
    } catch (e) { res.writeHead(500); return res.end(JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) })); }
  }

  // library のパターン削除
  if (u.pathname === "/delete-lib" && req.method === "POST") {
    res.setHeader("Content-Type", "application/json");
    let b = ""; req.on("data", (d) => (b += d));
    req.on("end", () => {
      try {
        let file = (JSON.parse(b).file || "").toString();
        if (file.indexOf("library/") !== 0 || file.indexOf("..") >= 0) { res.writeHead(400); return res.end('{"ok":false,"error":"bad path"}'); }
        fs.unlinkSync(path.join(__dirname, file));
        res.end('{"ok":true}');
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) })); }
    });
    return;
  }

  // library/*.json の一覧（name付き）。library.html / ハブが使う
  if (u.pathname === "/list") {
    res.setHeader("Content-Type", "application/json");
    let out = [];
    try {
      const dir = path.join(__dirname, "library");
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".json")) continue;
        let name = f;
        try { name = (JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).name) || f; } catch (e) {}
        out.push({ file: "library/" + f, name: name });
      }
    } catch (e) {}
    return res.end(JSON.stringify(out));
  }

  // チャット: claude -p（Maxのheadless Claude Code）を起動し mothership.json を編集させる（AI課金なし）
  if (u.pathname === "/chat" && req.method === "POST") {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      let msg = "", image = "", display = "";
      try { const j = JSON.parse(b); msg = (j.message || "").toString(); image = (j.image || "").toString(); display = (j.display || "").toString(); } catch (e) {}
      res.setHeader("Content-Type", "application/json");
      if (!msg.trim() && !image) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "メッセージが空です" })); }

      // 添付画像があればファイルに書き出し、claudeにReadさせる
      let prompt = msg;
      if (image && image.indexOf("data:image/") === 0) {
        try {
          const m = image.match(/^data:image\/(\w+);base64,(.*)$/);
          if (m) {
            const ext = m[1] === "jpeg" ? "jpg" : m[1];
            const fname = "_chat-ref." + ext;
            fs.writeFileSync(path.join(__dirname, fname), Buffer.from(m[2], "base64"));
            prompt = "ユーザーが参照画像を添付しました: ./" + fname + " （Readツールで画像を見て、デザインの参考にしてください）。\n\n" + (msg || "この画像を参考に、Mothership JSONでデザインを作って。");
          }
        } catch (e) {}
      }

      chatBusy = true; chatBusySince = Date.now();   // 生成開始（両画面で「考えています」同期用）
      appendLog({ cls: "me", text: display || msg });  // 発言を即サーバー保存（離脱しても残る）
      let done = false, activeChild = null;
      const finish = (obj) => {
        if (done) return; done = true; chatBusy = false; clearTimeout(timer); currentChild = null;
        const secs = ((Date.now() - chatBusySince) / 1000).toFixed(1);
        if (aborted) { aborted = false; appendLog({ cls: "ms", text: "⏹ 停止しました  ·  ⏱" + secs + "s" }); return res.end(JSON.stringify({ ok: false, aborted: true })); }
        // 返信もサーバーが保存（res.end前に書くので、どのタブに移動しても会話が継続する）
        if (obj.ok) appendLog({ cls: "ms", text: (obj.text || "（完了）") + "  ·  ⏱" + secs + "s" });
        else appendLog({ cls: "err", text: (obj.error || "失敗") + (obj.text ? "\n\n" + obj.text : "") });
        res.end(JSON.stringify(obj));
      };

      // claude -p を起動して mothership.json を編集させる
      const launch = (finalPrompt) => {
        let child;
        try {
          child = spawn("claude", ["-p", finalPrompt, "--permission-mode", "acceptEdits"], { cwd: __dirname, stdio: ["ignore", "pipe", "pipe"] });
        } catch (e) { return finish({ ok: false, error: "claude 起動失敗: " + (e && e.message ? e.message : e) }); }
        activeChild = child; currentChild = child;
        let out = "", err = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("error", (e) => finish({ ok: false, error: "claude が見つかりません（PATH確認）: " + (e && e.message ? e.message : e) }));
        child.on("close", (code) => {
          // 成功した設計を新規ライブラリファイルに自動保存（既存名は上書きしない＝保存忘れ→上書きでの喪失を防ぐ）
          if (code === 0) {
            try {
              const cur = read(); const j = JSON.parse(cur);
              const nm = (j.name || "").toString().replace(/[\\/:*?"<>|]+/g, "_").trim().slice(0, 60);
              if (nm) {
                const dir = path.join(__dirname, "library"); fs.mkdirSync(dir, { recursive: true });
                const f = path.join(dir, nm + ".json");
                if (!fs.existsSync(f)) fs.writeFileSync(f, cur);  // 同名が既にあれば触らない（手動保存/既存を尊重）
              }
            } catch (e) {}
          }
          finish({ ok: code === 0, text: out.trim(), error: err.trim(), code: code });
        });
      };

      // 安全弁: 300秒で打ち切り（採取最大90s＋生成）
      var timer = setTimeout(() => { try { if (activeChild) activeChild.kill(); } catch (e) {} finish({ ok: false, error: "タイムアウト（300s）" }); }, 300000);

      // ★URL再現の自動採取：メッセージにURL＋再現意図があれば、relayが先に採取してspecをclaudeに渡す
      //   （claudeはRead/Writeだけで済む＝Bash承認プロンプトが出ない＝チャットだけで完結）
      const urlMatch = msg.match(/https?:\/\/[^\s"'<>）)】」]+/);
      const wantsRepro = /再現|再構成|複製|コピー|clone|同じ|そっくり|作成して|作って|reproduce/i.test(msg);
      if (urlMatch && wantsRepro) {
        const url = urlMatch[0].replace(/[。、,]+$/, "");
        const mobile = /スマホ|モバイル|mobile|スマートフォン|390/i.test(msg);
        const w = mobile ? 390 : 1440, h = mobile ? 780 : 900;
        const safe = url.replace(/^https?:\/\//, "").replace(/[^\w.-]+/g, "_").slice(0, 60) || "ref";
        const outRel = "refs/" + safe + ".json";
        let capDone = false;
        const onCap = (ok) => {
          if (capDone) return; capDone = true;
          if (aborted) return finish({ ok: false, aborted: true });  // 採取中に停止されたらclaudeを起動しない
          const note = ok
            ? "【参照スペック採取済み】" + outRel + " に " + url + " のファーストビュー（算出スタイル付き構造JSON）がある。これを Read して、CLAUDE.md『URLからサイトを再現する』の手順で **そのKV（ファーストビュー）** を mothership.json に再現せよ。画像は元サイトのURLを image.src にそのまま入れてよい（relayが /pull で自動取り込み）。新しい name の新フレームで作り、最後に何をどこに出したか1〜2文で返答。\n\nユーザー依頼: "
            : "（参照URLの自動採取に失敗＝playwright未導入等の可能性。可能な範囲で対応し、無理なら一言添えて。）\n\n";
          launch(note + prompt);
        };
        let cap;
        try {
          cap = spawn("node", [path.join(__dirname, "tools", "url-to-spec.js"), url, "--w", String(w), "--h", String(h), "--out", outRel], { cwd: __dirname, stdio: ["ignore", "pipe", "pipe"] });
        } catch (e) { return onCap(false); }
        currentChild = cap;  // 採取中も /abort で止められる
        cap.on("error", () => onCap(false));
        cap.on("close", (code) => onCap(code === 0));
        setTimeout(() => { try { cap.kill(); } catch (e) {} onCap(false); }, 90000);
      } else {
        launch(prompt);
      }
    });
    return;
  }

  // 参照URL → スペック抽出（#12）。tools/url-to-spec.js を子プロセスで実行（playwrightは子側のみ＝relayは依存ゼロ維持）
  if (u.pathname === "/ref" && req.method === "POST") {
    let b = ""; req.on("data", (d) => (b += d));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      let url = "", w = 1440, h = 900;
      try { const j = JSON.parse(b); url = (j.url || "").toString(); if (j.w) w = parseInt(j.w, 10) || 1440; if (j.h) h = parseInt(j.h, 10) || 900; } catch (e) {}
      if (!/^https?:\/\//.test(url)) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "URLが不正です" })); }
      const safe = url.replace(/^https?:\/\//, "").replace(/[^\w.-]+/g, "_").slice(0, 60) || "ref";
      const outRel = "refs/" + safe + ".json";
      let child, err = "", done = false;
      const fail = (m) => { if (done) return; done = true; clearTimeout(timer); res.writeHead(500); res.end(JSON.stringify({ ok: false, error: m })); };
      try {
        child = spawn("node", [path.join(__dirname, "tools", "url-to-spec.js"), url, "--w", String(w), "--h", String(h), "--out", outRel], { cwd: __dirname, stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) { return fail("起動失敗: " + (e && e.message ? e.message : e)); }
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => fail("node起動失敗: " + (e && e.message ? e.message : e)));
      child.on("close", (code) => {
        if (done) return; done = true; clearTimeout(timer);
        if (code !== 0) { res.writeHead(500); return res.end(JSON.stringify({ ok: false, error: "採取失敗（playwright未導入の可能性）: " + err.trim().slice(-400) })); }
        try {
          const spec = JSON.parse(fs.readFileSync(path.join(__dirname, outRel), "utf8"));
          res.end(JSON.stringify({ ok: true, file: outRel, count: spec.count, spec: spec }));
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: "読込失敗: " + (e && e.message ? e.message : e) })); }
      });
      var timer = setTimeout(() => { try { child.kill(); } catch (e) {} fail("タイムアウト（90s）"); }, 90000);
    });
    return;
  }

  // 任意: HTTP経由で設計を流し込む（Claude Codeが curl で叩く用）
  if (u.pathname === "/push" && req.method === "POST") {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      try { JSON.parse(b); fs.writeFileSync(FILE, b); res.end("ok"); }
      catch (e) { res.writeHead(400); res.end("invalid json"); }
    });
    return;
  }

  // 静的配信（library.html / library/*.json など）。/ は library.html
  const safe = decodeURIComponent(u.pathname).replace(/\.\.+/g, "");
  const fp = path.join(__dirname, safe === "/" ? "library.html" : safe);
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    const ext = path.extname(fp).toLowerCase();
    const ct = ext === ".html" ? "text/html; charset=utf-8"
      : ext === ".json" ? "application/json; charset=utf-8"
      : ext === ".js" ? "text/javascript" : ext === ".css" ? "text/css"
      : ext === ".svg" ? "image/svg+xml"
      : ext === ".png" ? "image/png" : (ext === ".jpg" || ext === ".jpeg") ? "image/jpeg"
      : ext === ".webp" ? "image/webp" : "application/octet-stream";
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");  // ⌘Rで毎回最新を取得（キャッシュ無効）
    res.end(data);
  });
}).listen(PORT, () => {
  console.log("▲ Mothership relay  →  http://localhost:" + PORT);
  console.log("  watching : " + FILE);
  console.log("  Figmaでプラグイン Mothership を開き「接続」を押すとライブ連携が始まります。");
  console.log("  以後 mothership.json を保存するたび Figma が自動更新されます。");
  // claude CLI 自己チェック＝接続前に「AI（作る/整える/編集）が使えるか」を切り分ける（relayはリクエスト時に claude -p を spawn するため）
  try {
    var _cc = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 8000 });
    if (_cc.error || _cc.status !== 0) {
      console.log("  ⚠️  claude CLI が見つかりません → AI（作る/整える/会話編集）は動きません。");
      console.log("      Claude Code を入れてログイン（Pro/Max）してください: https://claude.com/claude-code");
      console.log("      ※ ⚡サンプル生成 は relay/claude なしでも動きます。");
    } else {
      console.log("  ✅ claude CLI OK (" + String(_cc.stdout || "").trim() + ") — AI機能が使えます（未ログインなら初回に要ログイン）。");
    }
  } catch (e) {
    console.log("  ⚠️  claude CLI チェックに失敗: " + (e && e.message ? e.message : e));
  }
});
