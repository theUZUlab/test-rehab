// client/main.js
const $status = document.getElementById('status');
const $data = document.getElementById('data');

async function fetchJson() {
  try {
    const url = `/server/realtime_hand_coordinates.json?_=${Date.now()}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    $status.textContent = `업데이트: ${new Date(json.timestamp * 1000).toLocaleTimeString()}`;
    render(json);
  } catch (err) {
    $status.innerHTML = `<span class="error">로드 실패: ${err.message}</span>`;
    console.error(err);
  }
}

function render(json) {
  const hands = Array.isArray(json.hands) ? json.hands : [];
  if (hands.length === 0) {
    $data.innerHTML = `<div class="card muted">손이 감지되지 않았습니다.</div>`;
    return;
  }

  const blocks = hands
    .map((hand) => {
      const fingers = hand.fingers || {};
      const fingerRows = Object.entries(fingers)
        .map(([name, info]) => {
          const x = info?.x ?? '-';
          const y = info?.y ?? '-';
          const len = info?.length_cm ?? NaN;
          const lenStr = Number.isFinite(len) ? `${len.toFixed(1)} cm` : '-';
          return `<div class="mono">• ${name.padEnd(6, ' ')}: (x=${x}, y=${y}), wrist→tip=${lenStr}</div>`;
        })
        .join('');

      return `
      <div class="card">
        <div><strong>Hand</strong>: ${hand.hand_label ?? '-'} <span class="muted">(index ${
        hand.hand_index ?? '-'
      })</span></div>
        <div style="margin-top:6px">${fingerRows}</div>
      </div>
    `;
    })
    .join('');

  $data.innerHTML = blocks;
}

// 첫 호출 + 폴링
fetchJson();
setInterval(fetchJson, 500);
