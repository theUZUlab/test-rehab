const $status = document.getElementById('status');
const $data = document.getElementById('data');

async function fetchJson() {
  try {
    const url = `/server/public/results/latest.json?_=${Date.now()}`;

    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json();

    $status.textContent = `업데이트: ${new Date().toLocaleTimeString()}`;
    renderData(json);
  } catch (err) {
    $status.innerHTML = `<span class="error">로드 실패: ${err.message}</span>`;
    console.error(err);
  }
}

function renderData(json) {
  const s = json.summary ?? {};
  const d = `
    <div class="data-block"><strong>ts:</strong> ${json.ts ?? '-'}</div>
    <div class="data-block"><strong>exercise:</strong> ${json.exercise ?? '-'}</div>
    <div class="data-block"><strong>phase:</strong> ${s.phase ?? '-'}</div>
    <div class="data-block"><strong>rep_count:</strong> ${s.rep_count ?? 0}</div>
    <div class="data-block"><strong>last_feedback:</strong> ${
      Array.isArray(s.last_feedback) ? s.last_feedback.join(', ') : s.last_feedback ?? '-'
    }</div>
    <div class="data-block"><strong>point:</strong> ${
      json.point ? `x=${json.point.x}, y=${json.point.y}, z=${json.point.z}` : '-'
    }</div>
  `;
  $data.innerHTML = d;
}

// 최초 호출 + 1초마다 갱신
fetchJson();
setInterval(fetchJson, 1000);
