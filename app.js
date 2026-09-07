/* =========================================================================
   カメラ → スプレッドシート
   スマホのカメラで写った数字・文字・バーコードをタップで選び、表に集めて
   TSV コピー / Google スプレッドシート追記 / CSV 保存する PWA。
   ========================================================================= */
'use strict';

const $ = (id) => document.getElementById(id);
const SCOPE_SHEETS = 'https://www.googleapis.com/auth/spreadsheets';

/* ---------------------------------------------------------------- 設定 */
const DEFAULTS = {
  ocrMode: 'alnum',
  preproc: true,
  maxSide: 1600,
  bcAuto: true,
  bcDedup: true,
  bcVibe: true,
  pushMode: 'gas',       // 'gas' = Apps Script ウェブアプリ / 'oauth' = Sheets API
  gasUrl: '',
  gasToken: '',
  gasSheet: '',
  gasAsText: true,
  gasStamp: false,
  gasViaTab: false,      // 直接送信できないと分かったら true（自動判定）
  gClientId: '',
  gSheetId: '',
  gSheetName: '',
  gClearAfter: true,
  cols: 1,
};
let cfg = { ...DEFAULTS };

function loadCfg() {
  try { cfg = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('c2s.cfg') || '{}') }; }
  catch { cfg = { ...DEFAULTS }; }
}
function saveCfg() {
  try { localStorage.setItem('c2s.cfg', JSON.stringify(cfg)); } catch {}
}

/* ---------------------------------------------------------------- 状態 */
const S = {
  stream: null,
  track: null,
  facing: 'environment',
  mode: 'live',          // 'live' | 'still'
  scanning: false,       // バーコード連続スキャン中
  zxing: null,           // ZXing reader (fallback)
  bd: null,              // BarcodeDetector
  bcLoopId: 0,
  lastBc: { v: '', t: 0 },
  seenBc: new Set(),
  items: [],             // {text,x,y,w,h,conf,kind}
  gran: 'word',          // 'word' | 'line'
  words: [],
  lines: [],
  bcBoxes: [],
  imgW: 0, imgH: 0,
  regionMode: false,
  drag: null,
  data: [[]],            // 表データ。最後の行が入力中の行
  lastAdd: null,
  worker: null,
  workerLang: '',
  busy: false,
};

/* オフスクリーン: 表示用（原画）と OCR 用（前処理後） */
const rawCanvas = document.createElement('canvas');
const ocrCanvas = document.createElement('canvas');

/* ================================================================ HUD */
function toast(html, ms = 2200, actions) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = html;
  if (actions) {
    for (const a of actions) {
      const b = document.createElement('button');
      b.textContent = a.label;
      b.onclick = () => { a.onClick(); el.remove(); };
      el.appendChild(b);
    }
  }
  $('hud').appendChild(el);
  if (ms) setTimeout(() => el.remove(), ms);
  return el;
}
function progress(p, label) {
  const box = $('prog');
  if (p === null) { box.style.display = 'none'; return; }
  box.style.display = 'block';
  box.firstElementChild.style.width = Math.round(p * 100) + '%';
  if (label) box.title = label;
}
function buzz(ms = 30) {
  if (cfg.bcVibe && navigator.vibrate) { try { navigator.vibrate(ms); } catch {} }
}

/* ============================================================== カメラ */
async function startCamera(facing = S.facing) {
  stopScan();
  if (S.stream) S.stream.getTracks().forEach(t => t.stop());
  const tries = [
    { video: { facingMode: { exact: facing }, width: { ideal: 2560 }, height: { ideal: 1440 } }, audio: false },
    { video: { facingMode: facing, width: { ideal: 1920 } }, audio: false },
    { video: true, audio: false },
  ];
  let err;
  for (const c of tries) {
    try {
      S.stream = await navigator.mediaDevices.getUserMedia(c);
      err = null; break;
    } catch (e) { err = e; }
  }
  if (err) {
    $('startOverlay').hidden = false;
    $('startOverlay').innerHTML =
      '<div style="max-width:24em"><b>カメラを開けませんでした</b>' +
      '<p style="color:var(--dim)">' + escapeHtml(err.name + ': ' + err.message) + '</p>' +
      '<p style="color:var(--dim)">HTTPS（または localhost）で開き、ブラウザのカメラ権限を許可してください。</p></div>';
    return;
  }
  S.facing = facing;
  const v = $('video');
  v.srcObject = S.stream;
  await v.play().catch(() => {});
  S.track = S.stream.getVideoTracks()[0];
  $('startOverlay').hidden = true;
  setupCameraControls();
}

function setupCameraControls() {
  const caps = S.track.getCapabilities ? S.track.getCapabilities() : {};
  const set = S.track.getSettings ? S.track.getSettings() : {};
  const z = $('zoom');
  if (caps.zoom) {
    z.min = caps.zoom.min; z.max = caps.zoom.max;
    z.step = caps.zoom.step || 0.1;
    z.value = set.zoom || caps.zoom.min;
    z.disabled = false;
  } else {
    z.disabled = true; z.min = 1; z.max = 1;
  }
  $('btnTorch').style.display = caps.torch ? '' : 'none';
}

$('zoom').oninput = async (e) => {
  if (!S.track) return;
  try { await S.track.applyConstraints({ advanced: [{ zoom: Number(e.target.value) }] }); } catch {}
};
let torchOn = false;
$('btnTorch').onclick = async () => {
  if (!S.track) return;
  torchOn = !torchOn;
  try {
    await S.track.applyConstraints({ advanced: [{ torch: torchOn }] });
    $('btnTorch').classList.toggle('on', torchOn);
  } catch { toast('この端末ではライトを操作できません'); }
};
$('btnFlip').onclick = () => startCamera(S.facing === 'environment' ? 'user' : 'environment');
$('btnStart').onclick = () => startCamera();

/* ==================================================== バーコード読取 */
async function initBarcode() {
  if ('BarcodeDetector' in window && !S.bd) {
    try {
      const fmts = await window.BarcodeDetector.getSupportedFormats();
      S.bd = new window.BarcodeDetector({ formats: fmts });
    } catch { S.bd = null; }
  }
  if (!S.bd && !S.zxing && window.ZXing) {
    const hints = new Map();
    S.zxing = new window.ZXing.BrowserMultiFormatReader(null, { delayBetweenScanAttempts: 150 });
    void hints;
  }
}

function onBarcode(text, format) {
  const now = Date.now();
  if (!text) return;
  if (text === S.lastBc.v && now - S.lastBc.t < 1500) return;
  S.lastBc = { v: text, t: now };
  if (/[#&]cfg=/.test(text)) {                 // 設定リンクの QR を写した
    const ok = importCfgFromString(text);
    buzz(40);
    toast(ok ? '設定リンクから連携設定を取り込みました' : '設定リンクを読み取れませんでした', 3500);
    if (ok) { stopScan(); openSettings(); }
    return;
  }
  if (cfg.bcDedup && S.seenBc.has(text)) {
    toast('重複スキップ <b>' + escapeHtml(text) + '</b>', 1200);
    return;
  }
  buzz(40);
  if (cfg.bcAuto) {
    S.seenBc.add(text);
    addValue(text);
    toast((format ? escapeHtml(String(format)) + ' ' : '') + '<b>' + escapeHtml(text) + '</b> を追加', 1800,
      [{ label: '取消', onClick: undoLast }]);
  } else {
    toast('<b>' + escapeHtml(text) + '</b>', 4000,
      [{ label: '追加', onClick: () => { S.seenBc.add(text); addValue(text); } }]);
  }
}

async function startScan() {
  if (S.mode !== 'live' || !S.stream) { toast('先にカメラを開始してください'); return; }
  await initBarcode();
  S.scanning = true;
  $('btnScan').classList.add('on');
  $('btnScan').textContent = 'スキャン停止';
  $('reticle').classList.add('on');

  if (S.bd) {
    const v = $('video');
    const tick = async () => {
      if (!S.scanning) return;
      try {
        const codes = await S.bd.detect(v);
        for (const c of codes) onBarcode(c.rawValue, c.format);
      } catch {}
      S.bcLoopId = setTimeout(tick, 160);
    };
    tick();
  } else if (S.zxing) {
    try {
      S.zxing.decodeFromVideoElement($('video'), (result) => {
        if (result && S.scanning) onBarcode(result.getText(), result.getBarcodeFormat?.());
      });
    } catch (e) { toast('スキャナを起動できません: ' + escapeHtml(e.message)); stopScan(); }
  } else {
    toast('この端末はバーコードスキャンに対応していません');
    stopScan();
  }
}

function stopScan() {
  S.scanning = false;
  clearTimeout(S.bcLoopId);
  if (S.zxing) { try { S.zxing.reset(); } catch {} }
  $('btnScan').classList.remove('on');
  $('btnScan').textContent = 'バーコード連続';
  $('reticle').classList.remove('on');
}
$('btnScan').onclick = () => (S.scanning ? stopScan() : startScan());

/* ======================================================== 撮影 & 解析 */
$('btnShoot').onclick = async () => {
  if (!S.stream) { toast('先にカメラを開始してください'); return; }
  if (S.busy) return;
  stopScan();
  capture();
  setMode('still');
  await analyze();
};
$('btnRetake').onclick = () => { setMode('live'); };
$('btnReocr').onclick = () => analyze();

function capture() {
  const v = $('video');
  const vw = v.videoWidth, vh = v.videoHeight;
  const max = Math.max(640, Math.min(4096, Number(cfg.maxSide) || 1600));
  const scale = Math.min(1, max / Math.max(vw, vh));
  const w = Math.round(vw * scale), h = Math.round(vh * scale);
  rawCanvas.width = w; rawCanvas.height = h;
  rawCanvas.getContext('2d').drawImage(v, 0, 0, w, h);
  S.imgW = w; S.imgH = h;

  const still = $('still');
  still.width = w; still.height = h;
  still.getContext('2d').drawImage(rawCanvas, 0, 0);
}

/* グレースケール + 2%〜98% のコントラストストレッチ */
function preprocess() {
  ocrCanvas.width = S.imgW; ocrCanvas.height = S.imgH;
  const ctx = ocrCanvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(rawCanvas, 0, 0);
  if (!cfg.preproc) return ocrCanvas;

  const img = ctx.getImageData(0, 0, S.imgW, S.imgH);
  const d = img.data, n = d.length / 4;
  const hist = new Uint32Array(256);
  const gray = new Uint8ClampedArray(n);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    gray[p] = g; hist[g]++;
  }
  const lowT = n * 0.02, highT = n * 0.98;
  let acc = 0, lo = 0, hi = 255;
  for (let g = 0; g < 256; g++) { acc += hist[g]; if (acc >= lowT) { lo = g; break; } }
  acc = 0;
  for (let g = 0; g < 256; g++) { acc += hist[g]; if (acc >= highT) { hi = g; break; } }
  if (hi - lo < 24) { lo = 0; hi = 255; }
  const k = 255 / (hi - lo);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    let g = (gray[p] - lo) * k;
    g = g < 0 ? 0 : g > 255 ? 255 : g;
    d[i] = d[i + 1] = d[i + 2] = g; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return ocrCanvas;
}

/* ------------------------------------------------------ OCR ワーカー */
function langsFor(mode) { return mode === 'jpn' ? 'jpn+eng' : 'eng'; }

async function getWorker() {
  const lang = langsFor(cfg.ocrMode);
  if (S.worker && S.workerLang === lang) return S.worker;
  if (S.worker) { try { await S.worker.terminate(); } catch {} S.worker = null; }
  progress(0.02, '辞書を読み込み中');
  S.worker = await window.Tesseract.createWorker(lang, 1, {
    logger: (m) => {
      if (typeof m.progress === 'number') progress(m.progress, m.status);
    },
  });
  S.workerLang = lang;
  return S.worker;
}

/* 文字ホワイトリスト。
   重要: 末尾の半角スペースを必ず含める。スペースを外すと Tesseract が単語の
   区切りを出力しなくなり（"SN 4562345" が "SN4562345" に結合される）、
   さらに単語の confidence が 0 に落ちて信頼度フィルタで全滅する。
   英数字モードは辞書と単語分割を活かした方が精度が高いので、
   ホワイトリストは使わず後段の cleanText() でフィルタする。 */
const WHITELIST = {
  digits: '0123456789.,-/: ',
};

async function setParams(worker, psm) {
  try {
    await worker.setParameters({
      tessedit_pageseg_mode: String(psm),
      preserve_interword_spaces: '1',
      tessedit_char_whitelist: WHITELIST[cfg.ocrMode] || '',
    });
  } catch {}
}

/* Tesseract v4/v5 どちらの戻り値でも words / lines を取り出す */
function flatten(data) {
  if (Array.isArray(data.words) && data.words.length) {
    return { words: data.words, lines: Array.isArray(data.lines) ? data.lines : [] };
  }
  const words = [], lines = [];
  for (const b of (data.blocks || [])) {
    for (const p of (b.paragraphs || [])) {
      for (const l of (p.lines || [])) {
        lines.push(l);
        for (const w of (l.words || [])) words.push(w);
      }
    }
  }
  return { words, lines };
}

function cleanText(t) {
  if (!t) return '';
  let s = String(t).replace(/[\r\n\t]+/g, ' ').trim();
  if (cfg.ocrMode === 'digits') {
    s = s.replace(/[^0-9.,\-/: ]+/g, '').trim();
  } else if (cfg.ocrMode === 'alnum') {
    s = s.replace(/[^\x20-\x7E]+/g, '').trim();
  } else {
    // 日本語は単語間に不要な空白が入りやすい
    if (/[　-ヿ一-鿿＀-￯]/.test(s)) s = s.replace(/\s+/g, '');
  }
  return s.replace(/\s{2,}/g, ' ').trim();
}

/* 意味のある文字を含むか（記号だけの断片を捨てる） */
function hasContent(s) {
  return cfg.ocrMode === 'digits'
    ? /[0-9]/.test(s)
    : /[0-9A-Za-z぀-ヿ㐀-鿿０-ｚ]/.test(s);
}

function toItem(o, kind) {
  const b = o.bbox || {};
  const text = cleanText(o.text);
  if (!text || !hasContent(text)) return null;
  const conf = typeof o.confidence === 'number' ? o.confidence : 0;
  /* conf === 0 は「未評価」のことがあるため一律で捨てない */
  if (conf > 0 && conf < 35) return null;
  if (conf === 0 && text.length < 2) return null;
  const x = b.x0 ?? 0, y = b.y0 ?? 0;
  const w = (b.x1 ?? 0) - x, h = (b.y1 ?? 0) - y;
  if (w < 6 || h < 6) return null;
  return { text, x, y, w, h, conf, kind };
}

async function analyze() {
  if (S.busy) return;
  S.busy = true;
  $('btnReocr').disabled = true;
  try {
    const worker = await getWorker();
    await setParams(worker, 3);                     // 3 = 自動ページ分割
    const src = preprocess();
    progress(0.05, 'OCR');
    const res = await worker.recognize(src, {}, { blocks: true, text: true });
    const { words, lines } = flatten(res.data || {});
    S.words = words.map(w => toItem(w, 'word')).filter(Boolean);
    S.lines = lines.map(l => toItem(l, 'line')).filter(Boolean);

    S.bcBoxes = await detectBarcodesOnCanvas();

    renderBoxes();
    const n = (S.gran === 'word' ? S.words : S.lines).length + S.bcBoxes.length;
    toast(n ? n + ' 件を検出。枠をタップしてください' : '文字を検出できませんでした。ズームや「範囲指定で読取」をお試しください', 2600);
  } catch (e) {
    toast('解析に失敗しました: ' + escapeHtml(e.message || String(e)), 4000);
  } finally {
    progress(null);
    $('btnReocr').disabled = false;
    S.busy = false;
  }
}

async function detectBarcodesOnCanvas() {
  await initBarcode();
  const out = [];
  if (S.bd) {
    try {
      const codes = await S.bd.detect(rawCanvas);
      for (const c of codes) {
        const bb = c.boundingBox;
        out.push({ text: c.rawValue, x: bb.x, y: bb.y, w: bb.width, h: bb.height, conf: 100, kind: 'bc' });
      }
    } catch {}
  } else if (S.zxing) {
    try {
      const r = S.zxing.decodeFromCanvas(rawCanvas);
      if (r) {
        const pts = r.getResultPoints ? r.getResultPoints() : [];
        let x = 0, y = 0, w = S.imgW, h = 40;
        if (pts && pts.length) {
          const xs = pts.map(p => p.getX()), ys = pts.map(p => p.getY());
          x = Math.min(...xs) - 10; y = Math.min(...ys) - 20;
          w = Math.max(...xs) - Math.min(...xs) + 20; h = Math.max(...ys) - Math.min(...ys) + 40;
        }
        out.push({ text: r.getText(), x, y, w: Math.max(w, 40), h: Math.max(h, 24), conf: 100, kind: 'bc' });
      }
    } catch {}
  }
  return out;
}

/* ================================================== オーバーレイ描画 */
function renderBoxes() {
  const host = $('boxes');
  host.innerHTML = '';
  const list = (S.gran === 'word' ? S.words : S.lines).concat(S.bcBoxes);
  for (const it of list) {
    const d = document.createElement('div');
    d.className = 'box' + (it.kind === 'bc' ? ' bc' : '');
    d.style.left = (it.x / S.imgW * 100) + '%';
    d.style.top = (it.y / S.imgH * 100) + '%';
    d.style.width = (it.w / S.imgW * 100) + '%';
    d.style.height = (it.h / S.imgH * 100) + '%';
    const lb = document.createElement('span');
    lb.className = 'lb';
    lb.textContent = it.text;
    d.appendChild(lb);
    d.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (S.regionMode) return;
      addValue(it.text);
      buzz(15);
      toast('<b>' + escapeHtml(it.text) + '</b> を追加', 1600, [{ label: '取消', onClick: undoLast }]);
    });
    host.appendChild(d);
  }
}

$('granSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  S.gran = b.dataset.g;
  [...$('granSeg').children].forEach(c => c.classList.toggle('on', c === b));
  renderBoxes();
});

/* -------------------------------------------------- 範囲指定して読取 */
$('btnRegion').onclick = () => {
  S.regionMode = !S.regionMode;
  $('btnRegion').classList.toggle('on', S.regionMode);
  $('stillInner').style.touchAction = S.regionMode ? 'none' : 'pan-y';
  $('boxes').style.display = S.regionMode ? 'none' : '';
  toast(S.regionMode ? '読み取りたい部分を指でドラッグして囲んでください' : '範囲指定を解除しました', 2200);
};

(function bindDrag() {
  const inner = $('stillInner'), sel = $('selRect');
  const pos = (ev) => {
    const r = $('still').getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top, r };
  };
  inner.addEventListener('pointerdown', (ev) => {
    if (!S.regionMode || S.mode !== 'still') return;
    const p = pos(ev);
    S.drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, r: p.r };
    sel.style.display = 'block';
    inner.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });
  inner.addEventListener('pointermove', (ev) => {
    if (!S.drag) return;
    const p = pos(ev);
    S.drag.x1 = p.x; S.drag.y1 = p.y;
    const x = Math.min(S.drag.x0, S.drag.x1), y = Math.min(S.drag.y0, S.drag.y1);
    sel.style.left = x + 'px'; sel.style.top = y + 'px';
    sel.style.width = Math.abs(S.drag.x1 - S.drag.x0) + 'px';
    sel.style.height = Math.abs(S.drag.y1 - S.drag.y0) + 'px';
  });
  inner.addEventListener('pointerup', async (ev) => {
    if (!S.drag) return;
    const d = S.drag; S.drag = null;
    sel.style.display = 'none';
    void ev;
    const scale = S.imgW / d.r.width;
    const x = Math.min(d.x0, d.x1) * scale, y = Math.min(d.y0, d.y1) * scale;
    const w = Math.abs(d.x1 - d.x0) * scale, h = Math.abs(d.y1 - d.y0) * scale;
    if (w < 12 || h < 8) { toast('もう少し大きく囲んでください'); return; }
    await ocrRegion(x, y, w, h);
  });
  inner.addEventListener('pointercancel', () => { S.drag = null; $('selRect').style.display = 'none'; });
})();

async function ocrRegion(x, y, w, h) {
  if (S.busy) return;
  S.busy = true;
  try {
    /* 切り出して 3 倍に拡大（小さな文字の認識率が大きく上がる） */
    const pad = 4;
    const sx = Math.max(0, x - pad), sy = Math.max(0, y - pad);
    const sw = Math.min(S.imgW - sx, w + pad * 2), sh = Math.min(S.imgH - sy, h + pad * 2);
    const up = Math.min(4, Math.max(2, 220 / Math.max(1, sh)));
    const c = document.createElement('canvas');
    c.width = Math.round(sw * up); c.height = Math.round(sh * up);
    const cx = c.getContext('2d');
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(preprocess(), sx, sy, sw, sh, 0, 0, c.width, c.height);

    const worker = await getWorker();
    /* 6 = 単一の均一なテキストブロック（切り出し領域に最適） */
    await setParams(worker, 6);
    progress(0.05, '範囲OCR');
    const res = await worker.recognize(c, {}, { blocks: true, text: true });

    /* まずバーコードとしても試す */
    let bcText = '';
    if (S.bd) {
      try {
        const codes = await S.bd.detect(c);
        if (codes.length) bcText = codes[0].rawValue;
      } catch {}
    }

    const text = bcText || cleanText((res.data && res.data.text) || '');
    if (!text) { toast('読み取れませんでした。もう少し大きく写して再試行してください', 3000); return; }
    addValue(text);
    buzz(20);
    toast('<b>' + escapeHtml(text) + '</b> を追加', 2600, [{ label: '取消', onClick: undoLast }]);
  } catch (e) {
    toast('範囲OCRに失敗: ' + escapeHtml(e.message || String(e)), 3500);
  } finally {
    progress(null);
    S.busy = false;
  }
}

/* ============================================================== モード */
function setMode(m) {
  S.mode = m;
  const live = m === 'live';
  $('liveWrap').style.display = live ? '' : 'none';
  $('stillInner').hidden = live;
  $('liveCtl').hidden = !live;
  $('stillCtl').hidden = live;
  /* 開始オーバーレイは画面全面を覆うので、静止画モードでは必ず退避させる */
  if (!live) $('startOverlay').hidden = true;
  if (live) {
    S.regionMode = false;
    $('btnRegion').classList.remove('on');
    $('boxes').style.display = '';
    $('boxes').innerHTML = '';
    $('video').play().catch(() => {});
  } else {
    $('video').pause();
  }
}

/* ============================================================= 表データ */
function cols() { return Math.max(1, Math.min(12, Number(cfg.cols) || 1)); }

function addValue(v) {
  v = String(v == null ? '' : v).trim();
  if (!v) return;
  if (!S.data.length) S.data.push([]);
  let cur = S.data[S.data.length - 1];
  if (cur.length >= cols()) { S.data.push([]); cur = S.data[S.data.length - 1]; }
  cur.push(v);
  S.lastAdd = { r: S.data.length - 1, c: cur.length - 1 };
  renderTable();
  persistData();
}
function undoLast() {
  if (!S.lastAdd) return;
  const { r } = S.lastAdd;
  if (S.data[r]) {
    S.data[r].pop();
    if (!S.data[r].length && S.data.length > 1) S.data.splice(r, 1);
  }
  S.lastAdd = null;
  renderTable();
  persistData();
}
$('btnNewRow').onclick = () => {
  if (S.data.length && S.data[S.data.length - 1].length) { S.data.push([]); renderTable(); persistData(); }
};
$('btnClear').onclick = () => {
  if (!nonEmptyRows().length) return;
  if (!confirm('表のデータを全て消去します。よろしいですか？')) return;
  S.data = [[]]; S.seenBc.clear(); S.lastAdd = null;
  renderTable(); persistData();
};
$('cols').oninput = (e) => { cfg.cols = Number(e.target.value) || 1; saveCfg(); renderTable(); };

function nonEmptyRows() {
  const n = cols();
  return S.data
    .filter(r => r.some(c => String(c).trim() !== ''))
    .map(r => { const o = r.slice(0, n); while (o.length < n) o.push(''); return o; });
}

function renderTable() {
  const n = cols();
  const rows = S.data.length ? S.data : (S.data = [[]]);
  const hasData = rows.some(r => r.length);
  $('empty').hidden = hasData;
  $('tbl').hidden = !hasData;
  $('sheetInfo').textContent = nonEmptyRows().length + ' 行 × ' + n + ' 列';
  if (!hasData) return;

  let th = '<tr><th></th>';
  for (let c = 0; c < n; c++) th += '<th>' + colName(c) + '</th>';
  th += '<th></th></tr>';
  $('thead').innerHTML = th;

  const tb = $('tbody');
  tb.innerHTML = '';
  rows.forEach((row, ri) => {
    const tr = document.createElement('tr');
    if (ri === rows.length - 1 && row.length < n) tr.className = 'cur';
    const idx = document.createElement('td');
    idx.className = 'idx'; idx.textContent = ri + 1;
    tr.appendChild(idx);
    for (let c = 0; c < n; c++) {
      const td = document.createElement('td');
      td.className = 'cell';
      td.contentEditable = 'true';
      td.spellcheck = false;
      td.textContent = row[c] != null ? row[c] : '';
      td.addEventListener('input', () => {
        while (S.data[ri].length <= c) S.data[ri].push('');
        S.data[ri][c] = td.textContent.replace(/\s+/g, ' ').trim();
        persistData();
      });
      tr.appendChild(td);
    }
    const act = document.createElement('td');
    act.className = 'act';
    const del = document.createElement('button');
    del.innerHTML = '&#10005;';
    del.title = 'この行を削除';
    del.onclick = () => {
      S.data.splice(ri, 1);
      if (!S.data.length) S.data = [[]];
      renderTable(); persistData();
    };
    act.appendChild(del);
    tr.appendChild(act);
    tb.appendChild(tr);
  });
  $('tableScroll').scrollTop = $('tableScroll').scrollHeight;
}
function colName(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = ((i - m) / 26) | 0; } return s; }

function persistData() {
  try { localStorage.setItem('c2s.data', JSON.stringify(S.data)); } catch {}
}
function restoreData() {
  try {
    const d = JSON.parse(localStorage.getItem('c2s.data') || 'null');
    if (Array.isArray(d) && d.length) S.data = d;
  } catch {}
}

/* ================================================================ 出力 */
function toTSV() { return nonEmptyRows().map(r => r.join('\t')).join('\n'); }
function toCSV() {
  const esc = (v) => /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  return '﻿' + nonEmptyRows().map(r => r.map(esc).join(',')).join('\r\n') + '\r\n';
}

$('btnCopy').onclick = async () => {
  const text = toTSV();                       // await の前に同期で作る（Safari 対策）
  if (!text) { toast('データがありません'); return; }
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch {}
  if (!ok) ok = legacyCopy(text);
  toast(ok
    ? 'TSV をコピーしました。スプレッドシートで貼り付けてください'
    : 'コピーに失敗しました。CSV 保存をお使いください', 3000);
};
function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  ta.remove();
  return ok;
}

$('btnCsv').onclick = () => {
  const csv = toCSV();
  if (csv.trim() === '﻿') { toast('データがありません'); return; }
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'capture-' + stamp() + '.csv';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
};
function stamp() {
  const d = new Date(), p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

/* ============================================ Google スプレッドシート */
let tokenClient = null, accessToken = null, tokenExp = 0;

function gStatus(msg, kind) {
  const el = $('gStatus');
  el.textContent = msg;
  el.className = 'status' + (kind ? ' ' + kind : '');
}
function sheetIdOf(v) {
  v = String(v || '').trim();
  const m = v.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : v;
}
function ensureTokenClient() {
  if (!cfg.gClientId) throw new Error('設定で OAuth クライアント ID を入力してください');
  if (!(window.google && window.google.accounts && window.google.accounts.oauth2)) {
    throw new Error('Google のライブラリを読み込めていません（オンラインで再読み込みしてください）');
  }
  if (tokenClient && tokenClient.__cid === cfg.gClientId) return tokenClient;
  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: cfg.gClientId,
    scope: SCOPE_SHEETS,
    callback: () => {},
  });
  tokenClient.__cid = cfg.gClientId;
  return tokenClient;
}
function getToken(interactive) {
  if (accessToken && Date.now() < tokenExp - 60000) return Promise.resolve(accessToken);
  const tc = ensureTokenClient();
  return new Promise((resolve, reject) => {
    tc.callback = (resp) => {
      if (resp && resp.access_token) {
        accessToken = resp.access_token;
        tokenExp = Date.now() + (Number(resp.expires_in || 3600) * 1000);
        gStatus('認証済み', 'ok');
        resolve(accessToken);
      } else {
        const e = (resp && (resp.error_description || resp.error)) || '認証がキャンセルされました';
        gStatus(String(e), 'err');
        reject(new Error(String(e)));
      }
    };
    tc.requestAccessToken({ prompt: interactive ? 'consent' : '' });
  });
}
$('btnAuth').onclick = async () => {
  try { await getToken(true); toast('Google 認証が完了しました'); }
  catch (e) { toast('認証エラー: ' + escapeHtml(e.message), 4000); }
};
$('btnRevoke').onclick = () => {
  if (accessToken && window.google && window.google.accounts) {
    try { window.google.accounts.oauth2.revoke(accessToken, () => {}); } catch {}
  }
  accessToken = null; tokenExp = 0;
  gStatus('未認証');
  toast('認証を解除しました');
};

$('btnPush').onclick = async () => {
  const rows = nonEmptyRows();
  if (!rows.length) { toast('データがありません'); return; }
  const gas = cfg.pushMode !== 'oauth';
  if (gas) {
    if (!gasUrlOk(cfg.gasUrl)) {
      openSettings();
      toast('設定で Apps Script の URL を入力するか、設定リンク（QR）を読み込んでください', 3500);
      return;
    }
  } else if (!cfg.gClientId || !sheetIdOf(cfg.gSheetId)) {
    openSettings();
    toast('設定で「クライアント ID」と「スプレッドシート」を入力してください', 3500);
    return;
  }
  const status = gas ? gasStatus : gStatus;
  const btn = $('btnPush');
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '送信中…';
  try {
    const r = gas ? await pushViaGas(rows) : { range: await pushViaOAuth(rows) };
    if (r.viaTab) {
      /* 結果はそのタブに表示される。確認できないので表は自動では消さない */
      toast('別タブで送信しました。開いたタブに「✓ 追記しました」と出れば完了です', 6000,
        [{ label: '表をクリア', onClick: () => { S.data = [[]]; S.lastAdd = null; renderTable(); persistData(); } }]);
      status('別タブで送信しました（結果はそのタブに表示）', 'ok');
      return;
    }
    const range = r.range;
    toast('スプレッドシートに ' + rows.length + ' 行を追記しました' + (range ? '（' + escapeHtml(range) + '）' : ''), 3200);
    status('最終送信: ' + rows.length + ' 行 ' + (range || ''), 'ok');
    if (cfg.gClearAfter) { S.data = [[]]; S.lastAdd = null; renderTable(); persistData(); }
  } catch (e) {
    toast('送信に失敗: ' + escapeHtml(e.message || String(e)), 5000);
    status('エラー: ' + (e.message || e), 'err');
  } finally {
    btn.disabled = false; btn.textContent = old;
  }
};

async function pushViaOAuth(rows) {
  const sid = sheetIdOf(cfg.gSheetId);
  let res = await appendRows(sid, rows, await getToken(false));
  if (res.status === 401) {
    accessToken = null;
    res = await appendRows(sid, rows, await getToken(true));
  }
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error((j.error && j.error.message) || (res.status + ' ' + res.statusText));
  }
  const j = await res.json();
  return (j.updates && j.updates.updatedRange) || '';
}

function appendRows(sid, rows, token) {
  const name = String(cfg.gSheetName || '').trim();
  const range = encodeURIComponent(name ? "'" + name.replace(/'/g, "''") + "'!A1" : 'A1');
  const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(sid) +
    '/values/' + range + ':append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS';
  return fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: rows }),
  });
}

/* ======================================= Apps Script ウェブアプリ連携 */
function gasStatus(msg, kind) {
  const el = $('gasStatus');
  el.textContent = msg;
  el.className = 'status' + (kind ? ' ' + kind : '');
}
/* 通常: https://script.google.com/macros/s/<ID>/exec
   組織限定デプロイ: https://script.google.com/a/macros/<ドメイン>/s/<ID>/exec の両方を受け付ける */
function gasUrlOk(u) {
  return /^https:\/\/script\.google\.com\/(?:macros|a\/macros\/[A-Za-z0-9.-]+)\/s\/[A-Za-z0-9_-]+\/exec$/.test(String(u || '').trim());
}
class GasUnreachable extends Error {}
async function gasFetch(body) {
  const url = String(cfg.gasUrl || '').trim();
  let res;
  try {
    /* Content-Type を text/plain にするとプリフライト無しで送れる
       （Apps Script は OPTIONS に応答しないため application/json では失敗する） */
    res = await fetch(url, body === undefined
      ? { method: 'GET', redirect: 'follow' }
      : { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) });
  } catch (e) {
    /* 「全員」に公開されていないデプロイは Google のログイン画面へ転送され、CORS で失敗する */
    throw new GasUnreachable('Apps Script に直接接続できません（デプロイが「全員」公開でない可能性）');
  }
  const txt = await res.text();
  let j;
  try { j = JSON.parse(txt); }
  catch { throw new Error('応答を解釈できません（HTTP ' + res.status + '）。URL が /exec で終わる最新のデプロイか確認してください'); }
  if (!j.ok) throw new Error(j.error || '不明なエラー');
  return j;
}
/* 直接送信できない組織向け: フォーム POST を新しいタブで開く。
   タブ内ではブラウザの Google ログインが使われるので「組織内の全員」公開でも届く。 */
function openGasTab(body) {
  const f = document.createElement('form');
  f.method = 'POST'; f.action = String(cfg.gasUrl || '').trim(); f.target = '_blank';
  f.style.display = 'none';
  const add = (n, v) => { const i = document.createElement('input'); i.type = 'hidden'; i.name = n; i.value = v; f.appendChild(i); };
  add('ui', '1');
  if (body) add('payload', JSON.stringify(body));
  document.body.appendChild(f);
  f.submit();
  f.remove();
}
function gasBody(rows) {
  return { token: String(cfg.gasToken || ''), sheet: String(cfg.gasSheet || ''), asText: !!cfg.gasAsText, stamp: !!cfg.gasStamp, rows };
}
/* 戻り値: { range } = 直接送信に成功 / { viaTab: true } = 別タブで送信した */
async function pushViaGas(rows) {
  const body = gasBody(rows);
  if (!cfg.gasViaTab) {
    try {
      const j = await gasFetch(body);
      return { range: j.range || '' };
    } catch (e) {
      if (!(e instanceof GasUnreachable)) throw e;
      cfg.gasViaTab = true; saveCfg();          // 次回からは最初から別タブで送る
    }
  }
  openGasTab(body);
  return { viaTab: true };
}
$('btnGasTest').onclick = async () => {
  if (!gasUrlOk(cfg.gasUrl)) { gasStatus('URL の形式が違います（…/exec で終わる URL を入れてください）', 'err'); return; }
  gasStatus('接続中…');
  try {
    const j = await gasFetch();
    cfg.gasViaTab = false; saveCfg();
    gasStatus('接続OK（直接送信）: ' + (j.name || 'スプレッドシート') + (Array.isArray(j.sheets) ? '（シート: ' + j.sheets.join(', ') + '）' : ''), 'ok');
  } catch (e) {
    if (e instanceof GasUnreachable) {
      cfg.gasViaTab = true; saveCfg();
      window.open(String(cfg.gasUrl).trim() + '?ui=1', '_blank');
      gasStatus('直接接続できないため「別タブで送信」モードにしました。開いたタブに「接続OK」と出れば使えます（Google へのログインを求められたら会社のアカウントでログイン）', 'ok');
    } else {
      gasStatus('エラー: ' + (e.message || e), 'err');
    }
  }
};

/* ---- 設定リンク: URL の #cfg=<base64url(JSON)> を開く／QR で写すと設定を取り込む ---- */
const CFG_KEYS = ['pushMode', 'gasUrl', 'gasToken', 'gasSheet', 'gasAsText', 'gasStamp',
  'gClientId', 'gSheetId', 'gSheetName', 'cols', 'ocrMode'];
function b64uEncode(str) {
  let bin = '';
  new TextEncoder().encode(str).forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return new TextDecoder().decode(Uint8Array.from(atob(s), c => c.charCodeAt(0)));
}
function buildCfgLink() {
  const o = {};
  for (const k of CFG_KEYS) if (cfg[k] !== undefined && cfg[k] !== '') o[k] = cfg[k];
  return location.origin + location.pathname + '#cfg=' + b64uEncode(JSON.stringify(o));
}
function importCfgFromString(str) {
  const m = String(str || '').match(/[#&]cfg=([A-Za-z0-9_-]+)/);
  if (!m) return false;
  let o;
  try { o = JSON.parse(b64uDecode(m[1])); } catch { return false; }
  if (!o || typeof o !== 'object') return false;
  if (o.gasUrl !== undefined && !gasUrlOk(o.gasUrl)) return false;   // Apps Script 以外の URL は取り込まない
  let n = 0;
  for (const k of CFG_KEYS) if (o[k] !== undefined) { cfg[k] = o[k]; n++; }
  if (!n) return false;
  saveCfg();
  settingsToUI();
  renderTable();
  return true;
}
function importCfgFromHash() {
  if (!/[#&]cfg=/.test(location.hash)) return;
  const ok = importCfgFromString(location.hash);
  history.replaceState(null, '', location.pathname + location.search);
  toast(ok ? '設定リンクから連携設定を取り込みました' : '設定リンクを読み取れませんでした', 3500);
}
$('btnCfgLink').onclick = async () => {
  if (!gasUrlOk(cfg.gasUrl) && !cfg.gClientId) { toast('先に連携設定を入力してください'); return; }
  const link = buildCfgLink();
  let ok = false;
  try { await navigator.clipboard.writeText(link); ok = true; } catch {}
  if (!ok) ok = legacyCopy(link);
  toast(ok ? '設定リンクをコピーしました。別のスマホでこのリンクを開くと同じ設定になります' : 'コピーに失敗しました', 3500);
};

/* ============================================================== 設定UI */
const BIND = [
  ['ocrMode', 'value'], ['preproc', 'checked'], ['maxSide', 'value'],
  ['bcAuto', 'checked'], ['bcDedup', 'checked'], ['bcVibe', 'checked'],
  ['pushMode', 'value'], ['gasUrl', 'value'], ['gasToken', 'value'], ['gasSheet', 'value'],
  ['gasAsText', 'checked'], ['gasStamp', 'checked'],
  ['gClientId', 'value'], ['gSheetId', 'value'], ['gSheetName', 'value'], ['gClearAfter', 'checked'],
];
function togglePushFields() {
  const gas = cfg.pushMode !== 'oauth';
  $('gasFields').hidden = !gas;
  $('oauthFields').hidden = gas;
}
function settingsToUI() {
  for (const [id, prop] of BIND) $(id)[prop] = cfg[id];
  $('cols').value = cols();
  togglePushFields();
}
function bindSettings() {
  for (const [id, prop] of BIND) {
    $(id).addEventListener('change', () => {
      const v = $(id)[prop];
      cfg[id] = prop === 'value' && id === 'maxSide' ? Number(v) : (typeof v === 'string' ? v.trim() : v);
      saveCfg();
      if (id === 'pushMode') togglePushFields();
      if (id === 'ocrMode' && S.worker && S.workerLang !== langsFor(cfg.ocrMode)) {
        toast('認識モードを変更しました。次の解析から反映されます');
      }
    });
  }
}
function openSettings() { settingsToUI(); $('mSettings').classList.add('on'); }
$('btnSettings').onclick = openSettings;
$('btnCloseSettings').onclick = () => $('mSettings').classList.remove('on');
$('btnHelp').onclick = () => $('mHelp').classList.add('on');
$('btnCloseHelp').onclick = () => $('mHelp').classList.remove('on');
for (const m of ['mSettings', 'mHelp']) {
  $(m).addEventListener('click', (e) => { if (e.target.id === m) $(m).classList.remove('on'); });
}

/* ================================================================ 雑務 */
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

window.addEventListener('beforeunload', (e) => {
  if (nonEmptyRows().length) { e.preventDefault(); e.returnValue = ''; }
});

/* ---------------------------------------------------------------- 起動 */
loadCfg();
restoreData();
importCfgFromHash();     // 設定リンク（#cfg=…）で開かれた場合は先に取り込む
settingsToUI();
bindSettings();
renderTable();
setMode('live');
$('originHint').textContent = location.origin;

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
if (!window.isSecureContext) {
  toast('HTTPS でないためカメラを使えません。HTTPS か localhost で開いてください', 8000);
}
