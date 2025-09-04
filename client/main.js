// HTML 문서에서 상태 표시 영역(#status)와 데이터 표시 영역(#data) 요소를 가져옴
const $status = document.getElementById('status');
const $data = document.getElementById('data');

// 서버에서 JSON 데이터를 불러오는 비동기 함수
async function fetchJson() {
  try {
    // 요청 URL: 캐시를 방지하기 위해 현재 시간을 쿼리스트링으로 추가
    const url = `/server/realtime_hand_coordinates.json?_=${Date.now()}`;
    // fetch로 JSON 요청 (cache: 'no-store' → 항상 최신 데이터 가져오기)
    const res = await fetch(url, { cache: 'no-store' });

    // 응답 상태 코드가 정상(200번대)이 아닐 경우 오류 발생
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // JSON 파싱
    const json = await res.json();

    // 상태 표시 영역에 마지막 업데이트 시간 출력
    $status.textContent = `업데이트: ${new Date(json.timestamp * 1000).toLocaleTimeString()}`;

    // 파싱한 JSON 데이터를 화면에 렌더링
    render(json);
  } catch (err) {
    // 오류 발생 시 상태 표시 영역에 에러 메시지 출력
    $status.innerHTML = `<span class="error">로드 실패: ${err.message}</span>`;
    console.error(err);
  }
}

// JSON 데이터를 화면에 렌더링하는 함수
function render(json) {
  // hands 배열 추출 (없으면 빈 배열로 처리)
  const hands = Array.isArray(json.hands) ? json.hands : [];

  // 손이 감지되지 않은 경우
  if (hands.length === 0) {
    $data.innerHTML = `<div class="card muted">손이 감지되지 않았습니다.</div>`;
    return;
  }

  // hands 배열의 각 요소(손)에 대해 HTML 블록 생성
  const blocks = hands
    .map((hand) => {
      const fingers = hand.fingers || {}; // fingers 정보 (없으면 빈 객체)

      // 각 손가락 데이터(x, y 좌표 + 손목에서 끝까지의 길이)를 행으로 변환
      const fingerRows = Object.entries(fingers)
        .map(([name, info]) => {
          const x = info?.x ?? '-';
          const y = info?.y ?? '-';
          const len = info?.length_cm ?? NaN;
          const lenStr = Number.isFinite(len) ? `${len.toFixed(1)} cm` : '-';

          // 손가락별 출력 포맷 (고정폭 글씨체 .mono)
          return `<div class="mono">• ${name.padEnd(6, ' ')}: (x=${x}, y=${y}), wrist→tip=${lenStr}</div>`;
        })
        .join('');

      // 하나의 손 카드(card) HTML 반환
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

  // 완성된 HTML 블록을 데이터 영역에 삽입
  $data.innerHTML = blocks;
}

// 첫 번째 호출 즉시 실행
fetchJson();

// 이후 0.5초(500ms)마다 fetchJson 반복 실행 → 실시간 업데이트 효과
setInterval(fetchJson, 500);
