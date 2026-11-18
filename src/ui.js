// 화면 UI 모듈: HUD(타이머·층수·안정성 게이지), 명예의 전당, 공학 리포트 팝업, 결과 화면, 가상 키패드
import { CAUSES } from './analyzer.js';
import { NAME_MAX, TOP_N } from './database.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KEY_ROWS = ['1234567890', 'QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];
const KEYPAD_IDLE_S = 60;      // 이름을 이만큼 아무것도 안 누르면 이름 없이 저장 (관람객이 그냥 떠난 경우)

function gaugeHTML(key, label) {
  return `<div class="gauge" data-key="${key}"><span>${label}</span><i><em></em></i><b>0%</b></div>`;
}

function setGauge(el, ratio) {
  const r = Math.max(0, ratio);
  el.querySelector('em').style.width = `${Math.min(1, r) * 100}%`;
  el.querySelector('b').textContent = `${Math.round(r * 100)}%`;
  el.dataset.level = r >= 1 ? 'over' : r >= 0.8 ? 'high' : r >= 0.5 ? 'mid' : 'low';
}

export class UI {
  constructor() {
    const labels = { bos: '기저면', torque: '돌림힘', friction: '마찰력' };
    $('gauge-list').innerHTML = Object.keys(labels).map(k => gaugeHTML(k, labels[k])).join('');
    $('rp-gauges').innerHTML = Object.keys(labels).map(k => gaugeHTML(k, CAUSES[k].name)).join('');
    this._reportTimer = null;
    this._keyHandler = null;
  }

  show(id, on = true) { $(id).classList.toggle('show', on); }

  setTimer(sec) {
    const s = Math.max(0, Math.ceil(sec));
    $('timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    $('timer').classList.toggle('warn', s <= 10);
  }

  setFloors(cur, best) {
    $('floor-cur').textContent = cur.toFixed(1);
    $('floor-best').textContent = best.toFixed(1);
  }

  setGauges(ratios) {
    for (const el of $('gauge-list').children) setGauge(el, ratios[el.dataset.key]);
  }

  setHint(html) { $('hint').innerHTML = html; }

  flash() {
    const f = $('flash');
    f.classList.remove('on');
    void f.offsetWidth;
    f.classList.add('on');
  }

  renderLeaderboard(rows, highlightId = null) {
    const list = $('lb-list');
    if (!rows.length) { list.innerHTML = '<li class="empty">아직 기록이 없습니다</li>'; return; }
    list.innerHTML = rows.map((r, i) => `
      <li class="${r.id === highlightId ? 'me' : ''}">
        <span class="rk">${i + 1}</span><span class="nm">${esc(r.player_name)}</span>
        <span class="fl">${Number(r.max_floor).toFixed(1)}층</span>
        ${r.failure_reason ? `<span class="rs">${esc(r.failure_reason)}</span>` : ''}
      </li>`).join('');
  }

  countdown(text, sub = '') {
    $('cd-num').textContent = text;
    $('cd-sub').textContent = sub;
    this.show('countdown', !!text);
  }

  // 오른쪽 아래: 지금 무엇으로 조작하는지 (손 인식 / 마우스)
  setInputStatus(info, available, source) {
    const el = $('input-status');
    if (!available) {
      el.dataset.mode = 'off';
      el.textContent = `마우스 조작 · 손 인식 꺼짐${info.error ? ` (${info.error})` : ''}`;
    } else {
      el.dataset.mode = source === 'hand' ? 'on' : 'wait';
      el.textContent = `손 인식 ${info.delegate?.toUpperCase() ?? ''} ${Math.round(info.fps || 0)}fps · `
        + (source === 'hand' ? (info.grab ? '쥠' : '폄') : '손을 카메라에 보여 주세요');
    }
  }

  // V 키: 손 인식 카메라 화면 (위치 맞출 때)
  togglePreview() {
    const img = $('preview');
    const on = !img.classList.contains('show');
    img.src = on ? '/video' : '';
    img.classList.toggle('show', on);
  }

  // 공학 리포트 팝업. seconds 뒤 자동으로 계속
  showReport(desc, rep, seconds, onContinue) {
    $('rp-title').textContent = desc.title;
    $('rp-title').style.color = desc.color;
    $('rp-en').textContent = desc.en;
    $('rp-summary').textContent = desc.summary;
    $('rp-lines').innerHTML = desc.lines.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('');
    $('rp-note').textContent = desc.note;
    $('rp-tip').textContent = desc.tip ? `TIP  ${desc.tip}` : '';
    for (const el of $('rp-gauges').children) {
      setGauge(el, rep.ratios[el.dataset.key]);
      el.classList.toggle('cause', el.dataset.key === rep.key);
    }
    const btn = $('rp-continue');
    let left = seconds;
    const finish = () => {
      clearInterval(this._reportTimer);
      btn.onclick = null;
      this.show('report', false);
      onContinue();
    };
    btn.querySelector('span').textContent = `(${left})`;
    btn.onclick = finish;
    clearInterval(this._reportTimer);
    this._reportTimer = setInterval(() => {
      left -= 1;
      btn.querySelector('span').textContent = `(${left})`;
      if (left <= 0) finish();
    }, 1000);
    this.show('report');
  }

  showGameOver({ title, floor, reason, msg, button }) {
    $('go-title').textContent = title;
    $('go-floor').innerHTML = `최종 기록 <b>${floor.toFixed(1)}</b>층`;
    $('go-reason').textContent = reason ? `마지막 붕괴 원인: ${reason}` : '한 번도 무너지지 않았습니다!';
    $('go-msg').textContent = msg || '';
    $('go-btn').textContent = button?.text || '';
    $('go-btn').style.display = button ? '' : 'none';
    $('go-btn').onclick = button?.onClick || null;
    this.show('gameover');
  }

  // 가상 키패드로 이름 입력 (실제 키보드도 가능). 완료하면 onDone(name), 오래 입력이 없으면 onDone(null)
  openKeypad(floor, rank, onDone) {
    let name = '', idle = KEYPAD_IDLE_S;
    const view = $('kp-name');
    const render = () => {
      view.textContent = name || ' ';
      view.classList.toggle('empty', !name);
      $('kp-idle').textContent = `${idle}초 동안 입력이 없으면 이름 없이 저장됩니다`;
    };
    const type = (k) => {
      idle = KEYPAD_IDLE_S;
      if (k === 'DEL') name = name.slice(0, -1);
      else if (k === 'OK') { close(); onDone(name || 'PLAYER'); return; }
      else if (name.length < NAME_MAX) name += k;
      render();
    };
    const close = () => {
      clearInterval(this._keypadTimer);
      window.removeEventListener('keydown', this._keyHandler);
      this.show('keypad', false);
    };
    clearInterval(this._keypadTimer);
    this._keypadTimer = setInterval(() => {
      if (--idle <= 0) { close(); onDone(null); } else render();
    }, 1000);
    $('kp-floor').innerHTML = `<b>${floor.toFixed(1)}</b>층 · ${rank}위 — 이름을 입력하세요 (최대 ${NAME_MAX}글자)`;
    const keys = $('kp-keys');
    keys.innerHTML = KEY_ROWS.map(row => `<div class="row">${[...row].map(c => `<button class="hand-btn key" data-k="${c}">${c}</button>`).join('')}</div>`).join('')
      + '<div class="row"><button class="hand-btn key wide" data-k="DEL">← 지우기</button><button class="hand-btn key wide ok" data-k="OK">완료</button></div>';
    keys.querySelectorAll('button').forEach(b => { b.onclick = () => type(b.dataset.k); });
    this._keyHandler = (e) => {
      if (e.key === 'Backspace') type('DEL');
      else if (e.key === 'Enter') type('OK');
      else if (/^[a-zA-Z0-9]$/.test(e.key)) type(e.key.toUpperCase());
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', this._keyHandler);
    render();
    this.show('keypad');
  }

  // 데이터 보기 (운영자용, 마우스): 지금까지 모든 게임 + 잘못된 기록 삭제
  showData(data, onDelete) {
    const cause = (r) => r || '-';
    $('dv-summary').innerHTML = [
      ['지금까지 플레이', `${data.total}명`],
      ['이름 남김', `${data.named}명`],
      ['평균 최고 층', `${data.avg_floor.toFixed(1)}층`],
      ['역대 최고', `${data.best_floor.toFixed(1)}층`],
    ].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
    $('dv-body').innerHTML = data.plays.length ? data.plays.map((p, i) => `
      <tr class="${p.rank ? 'ranked' : ''}">
        <td>${data.total - i}</td>
        <td>${p.player_name ? esc(p.player_name) : '<i>이름 없음</i>'}</td>
        <td><b>${p.max_floor.toFixed(1)}</b>층</td>
        <td>${p.rank ? `${p.rank}위` : '-'}</td>
        <td>${p.best_time_s != null ? `${p.best_time_s.toFixed(1)}초` : '-'}</td>
        <td>${p.collapses ?? 0}회</td>
        <td>${esc(cause(p.failure_reason))}</td>
        <td>${esc(p.created_at)}</td>
        <td><button class="dv-del" data-id="${p.id}" data-label="${data.total - i}번 ${esc(p.player_name || '이름 없음')} ${p.max_floor.toFixed(1)}층">삭제</button></td>
      </tr>`).join('') : '<tr><td colspan="9" class="dv-empty">아직 기록이 없습니다</td></tr>';
    $('dv-body').querySelectorAll('.dv-del').forEach(b => {
      b.onclick = () => {
        if (confirm(`${b.dataset.label} 기록을 삭제할까요?\n데이터와 명예의 전당에서 모두 지워지며 되돌릴 수 없습니다.`)) onDelete(Number(b.dataset.id));
      };
    });
    this.show('data-view');
  }

  get dataOpen() { return $('data-view').classList.contains('show'); }

  // 손 인식용: 화면 좌표의 버튼을 가리키기/누르기 (마우스일 때는 쓰지 않음)
  hoverAt(x, y) {
    const el = document.elementFromPoint(x, y)?.closest('.hand-btn');
    document.querySelectorAll('.hand-btn.hover').forEach(b => { if (b !== el) b.classList.remove('hover'); });
    el?.classList.add('hover');
    return el;
  }

  pressAt(x, y) {
    const el = this.hoverAt(x, y);
    el?.click();
    return !!el;
  }
}
