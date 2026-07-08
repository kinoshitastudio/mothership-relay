/* ===========================================================
   Mothership Reference Capture  —  #12「参照→スペック抽出」の種（PoC実証済み 2026-06-24）
   使い方：対象ページを開く → DevTools Console にこの全文を貼って Enter
   → ファーストビューの構造化JSON（実寸x/y/w/h・算出スタイル・重なり順・src・text）が
     クリップボードにコピーされる → Claude / Mothership に渡すと、画像推測ゼロで正確に実装/詰めできる。
   原理：html-to-figma系と同じ。getComputedStyle + getBoundingClientRect でブラウザの
     レンダリング後の値を採取する（＝画像ではなく"算出済みスタイル"が確実な情報）。
   将来：relayの受け口(/ref)やrefs/への投函 → Mothership JSON(tokens＋layout)へ正規化 → Figma＆コード両出力。
   =========================================================== */
(() => {
  const vw = innerWidth, vh = innerHeight;
  const WANT = ['position','display','flexDirection','justifyContent','alignItems','gap',
    'padding','backgroundColor','backgroundImage','color','fontFamily','fontSize','fontWeight',
    'lineHeight','letterSpacing','textAlign','borderRadius','border','boxShadow','opacity',
    'zIndex','backdropFilter','mixBlendMode','textTransform'];
  const clean = (v) => v && !['none','normal','auto','0px','rgba(0, 0, 0, 0)','static','0','start','rgb(0, 0, 0)'].includes(v);
  const nodes = [];
  function walk(el, depth) {
    if (depth > 14) return;
    for (const ch of el.children) {
      const r = ch.getBoundingClientRect();
      const cs = getComputedStyle(ch);
      if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
      if (r.width >= 6 && r.height >= 6 && r.top < vh * 1.15 && r.bottom > -40) {
        const n = { tag: ch.tagName.toLowerCase(), x: Math.round(r.left), y: Math.round(r.top),
          w: Math.round(r.width), h: Math.round(r.height), depth };
        for (const k of WANT) { const v = cs[k]; if (clean(v)) n[k] = v; }
        if (ch.tagName === 'IMG') n.src = ch.currentSrc || ch.src;
        if (ch.tagName === 'VIDEO') n.src = ch.currentSrc || (ch.querySelector('source')||{}).src || '(video)';
        const txt = [...ch.childNodes].filter(t => t.nodeType === 3).map(t => t.textContent.trim()).join(' ').trim();
        if (txt) n.text = txt.slice(0, 140);
        nodes.push(n);
      }
      walk(ch, depth + 1);
    }
  }
  walk(document.body, 0);
  const json = JSON.stringify({ url: location.href, viewport: { w: vw, h: vh }, capturedAt: new Date().toISOString(), count: nodes.length, nodes }, null, 2);
  try { (window.copy ? copy(json) : navigator.clipboard.writeText(json)); } catch (e) {}
  console.log('%cMothership: captured ' + nodes.length + ' nodes → クリップボードにコピー済み', 'color:#a89060;font-weight:bold');
  console.log(json);
  return json;
})();
