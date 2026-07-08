#!/usr/bin/env node
/* ============================================================================
   Mothership relay — ログイン時の自動起動を「初回1回」で登録するセットアップ。
   ターミナルを開き続けなくても relay が常駐し、Figma パネルの「接続」が必ず通る。

     node setup.js            … 自動起動を登録して今すぐ起動（mac/Windows）
     node setup.js --uninstall … 自動起動を解除
     node setup.js --status    … 現在の登録状況を表示

   仕組み:
     macOS  → ~/Library/LaunchAgents に LaunchAgent(plist) を置き launchctl で常駐
              （RunAtLoad=ログイン時起動 / KeepAlive=落ちても自動再起動）
     Windows→ スタートアップに VBS を置きログイン時に relay を隠しウィンドウで起動

   PATH の要点: relay は `claude` と `node` を素の名前で起動するため、
   自動起動環境の最小 PATH に node と claude のディレクトリを必ず通す。
   ここでは「今このセットアップを動かしている node」(process.execPath) と、
   検出した claude の場所を使うので、環境に合わせて自動で正しく通る。
   ============================================================================ */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const LABEL = "studio.kinoshita.mothership-relay";
const DIR = __dirname;                       // relay.js のあるフォルダ
const RELAY = path.join(DIR, "relay.js");
const NODE = process.execPath;               // 実行中の node = 確実に存在する絶対パス
const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

function log(s) { process.stdout.write(s + "\n"); }
function ok(s) { log("  ✅ " + s); }
function warn(s) { log("  ⚠  " + s); }

// claude CLI の場所を検出 → その dir を PATH に足す（見つからなくても致命ではない）
function findDir(bin) {
  try {
    const cmd = IS_WIN ? ("where " + bin) : ("command -v " + bin);
    const out = cp.execSync(cmd, { shell: true, encoding: "utf8" }).trim().split(/\r?\n/)[0].trim();
    if (out && fs.existsSync(out)) return path.dirname(out);
  } catch (e) {}
  return null;
}

function assertRelayExists() {
  if (!fs.existsSync(RELAY)) {
    warn("relay.js が見つかりません: " + RELAY);
    warn("このスクリプトは relay.js と同じフォルダに置いて実行してください。");
    process.exit(1);
  }
}

/* ----------------------------- macOS ----------------------------- */
function macPlistPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", LABEL + ".plist");
}
function macBuildPath() {
  const dirs = [path.dirname(NODE), findDir("claude"),
    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const seen = {}, out = [];
  for (const d of dirs) { if (d && !seen[d]) { seen[d] = 1; out.push(d); } }
  return out.join(":");
}
function macPlist() {
  const logDir = path.join(os.homedir(), "Library", "Logs");
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0"><dict>\n' +
    "  <key>Label</key><string>" + LABEL + "</string>\n" +
    "  <key>ProgramArguments</key><array>\n" +
    "    <string>" + esc(NODE) + "</string>\n" +
    "    <string>" + esc(RELAY) + "</string>\n" +
    "  </array>\n" +
    "  <key>WorkingDirectory</key><string>" + esc(DIR) + "</string>\n" +
    "  <key>EnvironmentVariables</key><dict><key>PATH</key><string>" + esc(macBuildPath()) + "</string></dict>\n" +
    "  <key>RunAtLoad</key><true/>\n" +
    "  <key>KeepAlive</key><true/>\n" +
    "  <key>StandardOutPath</key><string>" + esc(path.join(logDir, "mothership-relay.out.log")) + "</string>\n" +
    "  <key>StandardErrorPath</key><string>" + esc(path.join(logDir, "mothership-relay.err.log")) + "</string>\n" +
    "</dict></plist>\n";
}
function launchctl(args, ignore) {
  try { cp.execFileSync("launchctl", args, { stdio: "ignore" }); return true; }
  catch (e) { if (!ignore) return false; return false; }
}
function macInstall() {
  const p = macPlistPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, macPlist());
  ok("LaunchAgent を書き出し: " + p);
  const domain = "gui/" + process.getuid();
  // 既存を外してから読み込む（モダン: bootstrap、旧OSは load -w にフォールバック）
  launchctl(["bootout", domain, p], true);
  launchctl(["bootout", domain + "/" + LABEL], true);
  if (!launchctl(["bootstrap", domain, p], true)) {
    if (!launchctl(["load", "-w", p], true)) warn("launchctl での読み込みに失敗。再ログインで有効になります。");
  }
  launchctl(["enable", domain + "/" + LABEL], true);
  launchctl(["kickstart", "-k", domain + "/" + LABEL], true);   // 今すぐ起動/再起動
  ok("ログイン時に自動起動＋落ちても自動再起動する設定にしました。");
}
function macUninstall() {
  const p = macPlistPath();
  const domain = "gui/" + process.getuid();
  launchctl(["bootout", domain, p], true);
  launchctl(["bootout", domain + "/" + LABEL], true);
  launchctl(["unload", "-w", p], true);
  if (fs.existsSync(p)) { fs.unlinkSync(p); ok("LaunchAgent を削除: " + p); }
  else ok("LaunchAgent は既にありません。");
}
function macStatus() {
  const p = macPlistPath();
  log("  plist: " + (fs.existsSync(p) ? p : "（未登録）"));
  try {
    const out = cp.execSync("launchctl list 2>/dev/null | grep " + LABEL, { shell: true, encoding: "utf8" }).trim();
    log("  launchctl: " + (out || "（未ロード）"));
  } catch (e) { log("  launchctl: （未ロード）"); }
}

/* ----------------------------- Windows ----------------------------- */
function winStartupDir() {
  const base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(base, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}
function winVbsPath() { return path.join(winStartupDir(), "MothershipRelay.vbs"); }
function winVbs() {
  // 隠しウィンドウ(0)で node relay.js を起動。作業フォルダを relay の場所に設定。
  const q = (s) => '"" & Chr(34) & "' + String(s).replace(/"/g, '""') + '" & Chr(34) & ""';
  return 'Set sh = CreateObject("WScript.Shell")\r\n' +
    'sh.CurrentDirectory = ' + q(DIR) + '\r\n' +
    'sh.Run ' + q(NODE) + ' & " " & ' + q(RELAY) + ', 0, False\r\n';
}
function winInstall() {
  const dir = winStartupDir();
  fs.mkdirSync(dir, { recursive: true });
  const v = winVbsPath();
  fs.writeFileSync(v, winVbs());
  ok("スタートアップに登録: " + v);
  try { cp.spawn("wscript", [v], { detached: true, stdio: "ignore" }).unref(); ok("今すぐ relay を起動しました（隠しウィンドウ）。"); }
  catch (e) { warn("今すぐ起動は失敗（次回ログインで起動します）: " + e.message); }
}
function winUninstall() {
  const v = winVbsPath();
  if (fs.existsSync(v)) { fs.unlinkSync(v); ok("スタートアップ登録を削除: " + v); }
  else ok("スタートアップ登録は既にありません。");
}
function winStatus() {
  const v = winVbsPath();
  log("  startup vbs: " + (fs.existsSync(v) ? v : "（未登録）"));
}

/* ----------------------------- main ----------------------------- */
const mode = (process.argv[2] || "").replace(/^-+/, "");
log("∞ Mothership relay セットアップ");
log("  node : " + NODE);
log("  relay: " + RELAY);
if (!IS_WIN && !IS_MAC) { warn("このOS(" + process.platform + ")は自動対応外です。手動で `node relay.js` を常駐させてください。"); process.exit(1); }

if (mode === "status") {
  (IS_WIN ? winStatus : macStatus)();
  log("  接続先: http://localhost:" + (process.env.PORT || 4575));
} else if (mode === "uninstall" || mode === "remove") {
  (IS_WIN ? winUninstall : macUninstall)();
  log("  解除しました。");
} else {
  assertRelayExists();
  (IS_WIN ? winInstall : macInstall)();
  log("  完了。Figma で Mothership を開き「接続」を押してください（http://localhost:" + (process.env.PORT || 4575) + "）。");
}
