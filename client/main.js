// ==============================
// main.js
// ==============================

// --- DOM refs ---
const $status = document.getElementById('status');
const $data = document.getElementById('data');

// 캔버스가 없으면 동적으로 생성
let $canvas = document.getElementById('viz');
if (!$canvas) {
  $canvas = document.createElement('canvas');
  $canvas.id = 'viz';
  $canvas.style.width = '100%';
  $canvas.style.maxWidth = '640px';
  $canvas.style.aspectRatio = '16 / 9';
  $canvas.style.border = '1px solid var(--border, #ddd)';
  $canvas.style.borderRadius = '12px';
  $canvas.style.display = 'block';
  $canvas.style.margin = '12px 0';
  // 상태/데이터 영역 근처에 삽입
  ($data?.parentElement || document.body).insertBefore($canvas, $data);
}
const ctx = $canvas.getContext('2d');

// --- Config ---
const FETCH_URL = `/server/outputs/right_arm_latest.json`;
const FETCH_INTERVAL_MS = 500; // 서버 폴링 주기
const SMOOTHING_PER_SEC = 10; // 큰 값일수록 빠르게 따라감(지수 보간 계수)
const DEFAULT_IMG_W = 1280; // 서버에서 image_size 미제공 시 기본값
const DEFAULT_IMG_H = 720;

// --- State (animation) ---
let imgW = DEFAULT_IMG_W;
let imgH = DEFAULT_IMG_H;

let currentPose = null; // {shoulder:{x,y}, elbow:{x,y}, wrist:{x,y}, hip:{x,y}}
let targetPose = null; // 위와 동일
let currentAngles = { shoulder: null, elbow: null };
let targetAngles = { shoulder: null, elbow: null };
let lastFrameTime = performance.now();
let lastTimestamp = null; // 서버 timestamp

// --- Helpers ---
function ensureCanvasBackingStore() {
  // CSS 너비에 맞추어 실제 캔버스 해상도 조정 (HiDPI 대응)
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = Math.min($canvas.clientWidth || 640, 640);
  const cssHeight = Math.round(cssWidth * (imgH / imgW));

  $canvas.width = Math.round(cssWidth * dpr);
  $canvas.height = Math.round(cssHeight * dpr);
  $canvas.style.width = cssWidth + 'px';
  $canvas.style.height = cssHeight + 'px';

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// 원 좌표(px)를 캔버스 좌표로 스케일링
function scalePoint(pt) {
  const cw = $canvas.clientWidth || 640;
  const ch = Math.round(cw * (imgH / imgW));
  const sx = cw / imgW;
  const sy = ch / imgH;
  return { x: pt.x * sx, y: pt.y * sy };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}
function lerpPoint(pa, pb, t) {
  if (!pa) return pb;
  if (!pb) return pa;
  return { x: lerp(pa.x, pb.x, t), y: lerp(pa.y, pb.y, t) };
}

// --- Parsing: 두 가지 스키마 모두 지원 ---
function parseIncoming(json) {
  // case A: hands[*] 구조
  if (Array.isArray(json?.hands) && json.hands.length > 0) {
    const hand = json.hands[0];
    const f = hand.fingers || {};
    // angles
    const angles = hand.angles_deg || json.angles_deg || {};
    // timestamp
    const ts = typeof json.timestamp === 'number' ? json.timestamp : Math.floor(Date.now() / 1000);

    // image_size (있으면 반영)
    if (json.image_size?.w && json.image_size?.h) {
      imgW = json.image_size.w;
      imgH = json.image_size.h;
    }

    return {
      timestamp: ts,
      points: {
        shoulder: f.shoulder ? { x: f.shoulder.x, y: f.shoulder.y } : null,
        elbow: f.elbow ? { x: f.elbow.x, y: f.elbow.y } : null,
        wrist: f.wrist ? { x: f.wrist.x, y: f.wrist.y } : null,
        hip: f.hip ? { x: f.hip.x, y: f.hip.y } : null,
      },
      angles: {
        shoulder: isFinite(angles.shoulder) ? angles.shoulder : null,
        elbow: isFinite(angles.elbow) ? angles.elbow : null,
      },
      hand_label: hand.hand_label ?? json.side ?? '-',
      hand_index: hand.hand_index ?? 0,
      raw: json,
    };
  }

  // case B: *_px + angles_deg 구조
  const tsKst = json?.ts_kst;
  const ts = tsKst ? Math.floor(new Date(tsKst).getTime() / 1000) : Math.floor(Date.now() / 1000);

  // image_size 반영
  if (json?.image_size?.w && json?.image_size?.h) {
    imgW = json.image_size.w;
    imgH = json.image_size.h;
  }

  const asPoint = (arr) => (Array.isArray(arr) && arr.length >= 2 ? { x: arr[0], y: arr[1] } : null);

  return {
    timestamp: ts,
    points: {
      shoulder: asPoint(json.shoulder_px),
      elbow: asPoint(json.elbow_px),
      wrist: asPoint(json.wrist_px),
      hip: asPoint(json.hip_px),
    },
    angles: {
      shoulder: isFinite(json?.angles_deg?.shoulder) ? json.angles_deg.shoulder : null,
      elbow: isFinite(json?.angles_deg?.elbow) ? json.angles_deg.elbow : null,
    },
    hand_label: json?.side ?? '-',
    hand_index: 0,
    raw: json,
  };
}

// --- Fetch & Render (text/card) ---
async function fetchJson() {
  try {
    const url = `${FETCH_URL}?_=${Date.now()}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json();
    const parsed = parseIncoming(json);

    // 상태 갱신
    lastTimestamp = parsed.timestamp;
    $status.textContent = `업데이트: ${new Date(parsed.timestamp * 1000).toLocaleTimeString()}`;

    // 애니메이션 타깃 갱신
    targetPose = parsed.points;
    targetAngles = parsed.angles;

    // 텍스트 카드 렌더
    renderTextCard(parsed);
  } catch (err) {
    $status.innerHTML = `<span class="error">로드 실패: ${err.message}</span>`;
    console.error(err);
  }
}

function renderTextCard(parsed) {
  // hands 구조에 준하는 카드 하나를 합성해 표시
  const f = {
    shoulder: parsed.points.shoulder
      ? { x: parsed.points.shoulder.x, y: parsed.points.shoulder.y, length_cm: NaN }
      : null,
    elbow: parsed.points.elbow ? { x: parsed.points.elbow.x, y: parsed.points.elbow.y, length_cm: NaN } : null,
    wrist: parsed.points.wrist ? { x: parsed.points.wrist.x, y: parsed.points.wrist.y, length_cm: NaN } : null,
    hip: parsed.points.hip ? { x: parsed.points.hip.x, y: parsed.points.hip.y, length_cm: NaN } : null,
  };

  const entries = Object.entries(f).filter(([, v]) => !!v);

  const rows = entries
    .map(([name, info]) => {
      const x = info.x ?? '-';
      const y = info.y ?? '-';
      const len = info.length_cm ?? NaN;
      const lenStr = Number.isFinite(len) ? `${len.toFixed(1)} cm` : '-';
      return `<div class="mono">• ${name.padEnd(8, ' ')}: (x=${x}, y=${y}), wrist→tip=${lenStr}</div>`;
    })
    .join('');

  const angleText = `
    <div class="mono" style="margin-top:6px">
      ◦ angles: shoulder=${isFinite(parsed.angles.shoulder) ? parsed.angles.shoulder.toFixed(2) : '-'}°,
                elbow=${isFinite(parsed.angles.elbow) ? parsed.angles.elbow.toFixed(2) : '-'}°
    </div>`;

  const html = `
    <div class="card">
      <div><strong>Hand</strong>: ${parsed.hand_label} <span class="muted">(index ${parsed.hand_index})</span></div>
      <div class="muted" style="margin-top:2px">image: ${imgW}×${imgH}px, ts=${parsed.timestamp}</div>
      <div style="margin-top:6px">${rows || '<div class="mono">• -</div>'}</div>
      ${angleText}
    </div>
  `;
  $data.innerHTML = html;
}

// --- Drawing ---
function drawSkeleton() {
  ensureCanvasBackingStore();
  ctx.clearRect(0, 0, $canvas.width, $canvas.height);

  if (!currentPose) return;

  const pts = {};
  for (const key of ['shoulder', 'elbow', 'wrist', 'hip']) {
    if (currentPose[key]) pts[key] = scalePoint(currentPose[key]);
  }

  // 스타일
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#666';
  ctx.fillStyle = '#111';
  ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

  // 뼈대: shoulder→elbow→wrist
  if (pts.shoulder && pts.elbow) {
    ctx.beginPath();
    ctx.moveTo(pts.shoulder.x, pts.shoulder.y);
    ctx.lineTo(pts.elbow.x, pts.elbow.y);
    ctx.stroke();
  }
  if (pts.elbow && pts.wrist) {
    ctx.beginPath();
    ctx.moveTo(pts.elbow.x, pts.elbow.y);
    ctx.lineTo(pts.wrist.x, pts.wrist.y);
    ctx.stroke();
  }

  // 참조선: hip→shoulder (점선)
  if (pts.hip && pts.shoulder) {
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(pts.hip.x, pts.hip.y);
    ctx.lineTo(pts.shoulder.x, pts.shoulder.y);
    ctx.stroke();
    ctx.restore();
  }

  // 포인트 원 & 라벨
  const drawPoint = (p, label) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillText(label, p.x + 6, p.y - 6);
  };
  if (pts.shoulder) drawPoint(pts.shoulder, 'shoulder');
  if (pts.elbow) drawPoint(pts.elbow, 'elbow');
  if (pts.wrist) drawPoint(pts.wrist, 'wrist');
  if (pts.hip) drawPoint(pts.hip, 'hip');

  // 각도 텍스트
  const sh = isFinite(currentAngles.shoulder) ? currentAngles.shoulder.toFixed(1) : '-';
  const el = isFinite(currentAngles.elbow) ? currentAngles.elbow.toFixed(1) : '-';
  ctx.fillText(`angles: shoulder=${sh}°, elbow=${el}°`, 10, 20);
}

// --- Animation loop (exponential smoothing toward target) ---
function tick(tNow) {
  const dt = Math.max(0, (tNow - lastFrameTime) / 1000); // sec
  lastFrameTime = tNow;

  // 지수 보간 비율: 1 - exp(-k * dt)
  const k = SMOOTHING_PER_SEC;
  const alpha = 1 - Math.exp(-k * dt);

  if (targetPose) {
    if (!currentPose) currentPose = structuredClone(targetPose);
    currentPose = {
      shoulder:
        targetPose.shoulder || currentPose.shoulder
          ? lerpPoint(currentPose.shoulder, targetPose.shoulder, alpha)
          : null,
      elbow: targetPose.elbow || currentPose.elbow ? lerpPoint(currentPose.elbow, targetPose.elbow, alpha) : null,
      wrist: targetPose.wrist || currentPose.wrist ? lerpPoint(currentPose.wrist, targetPose.wrist, alpha) : null,
      hip: targetPose.hip || currentPose.hip ? lerpPoint(currentPose.hip, targetPose.hip, alpha) : null,
    };
  }

  if (targetAngles) {
    if (!isFinite(currentAngles.shoulder)) currentAngles.shoulder = targetAngles.shoulder ?? null;
    if (!isFinite(currentAngles.elbow)) currentAngles.elbow = targetAngles.elbow ?? null;

    // 각도는 간단 선형 보간
    if (isFinite(targetAngles.shoulder) && isFinite(currentAngles.shoulder)) {
      currentAngles.shoulder = lerp(currentAngles.shoulder, targetAngles.shoulder, alpha);
    } else {
      currentAngles.shoulder = targetAngles.shoulder ?? currentAngles.shoulder ?? null;
    }
    if (isFinite(targetAngles.elbow) && isFinite(currentAngles.elbow)) {
      currentAngles.elbow = lerp(currentAngles.elbow, targetAngles.elbow, alpha);
    } else {
      currentAngles.elbow = targetAngles.elbow ?? currentAngles.elbow ?? null;
    }
  }

  drawSkeleton();
  requestAnimationFrame(tick);
}

// --- Bootstrap ---
fetchJson();
setInterval(fetchJson, FETCH_INTERVAL_MS);
requestAnimationFrame((t) => {
  lastFrameTime = t;
  requestAnimationFrame(tick);
});

// 반응형 리사이즈
window.addEventListener('resize', () => {
  ensureCanvasBackingStore();
  drawSkeleton();
});
