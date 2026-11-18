// 레이저 챌린지 그리기 (캔버스 2D, 네온 스타일). 논리 좌표 1280×720.
import { W, H, COLORS } from './levels.js';
import { mirrorEnds, dirFromDeg, deg, norm180 } from './optics.js';

export const FONT = '"Pretendard","Noto Sans KR","Malgun Gothic","Apple SD Gothic Neo",system-ui,sans-serif';
export const CYAN = '#4cf0ff';
export const BG = '#050914';

export function txt(ctx, s, x, y, { size = 24, color = '#e8f6ff', align = 'center', weight = '700', alpha = 1, glow = null, baseline = 'middle' } = {}) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.textAlign = align; ctx.textBaseline = baseline;
  if (glow) { ctx.shadowColor = glow; ctx.shadowBlur = size * 0.6; }
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
  ctx.restore();
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function panel(ctx, x, y, w, h, { fill = 'rgba(8,16,34,0.82)', stroke = 'rgba(76,240,255,0.35)', r = 16 } = {}) {
  ctx.save();
  roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = fill; ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = stroke; ctx.stroke();
  ctx.restore();
}

export function drawBackground(ctx, t = 0) {
  ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.strokeStyle = 'rgba(76,240,255,0.06)'; ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y <= H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, W * 0.75);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(76,240,255,0.25)'; ctx.lineWidth = 3; ctx.strokeRect(2, 2, W - 4, H - 4);
  ctx.restore();
}

export function drawObstacles(ctx, obstacles) {
  for (const o of obstacles) {
    ctx.save();
    ctx.fillStyle = '#0d1424'; ctx.fillRect(o.x, o.y, o.w, o.h);
    ctx.beginPath(); ctx.rect(o.x, o.y, o.w, o.h); ctx.clip();
    ctx.strokeStyle = 'rgba(120,140,180,0.35)'; ctx.lineWidth = 3;
    for (let k = -o.h; k < o.w + o.h; k += 18) { ctx.beginPath(); ctx.moveTo(o.x + k, o.y + o.h); ctx.lineTo(o.x + k + o.h, o.y); ctx.stroke(); }
    ctx.restore();
    ctx.save(); ctx.strokeStyle = '#6b7aa0'; ctx.lineWidth = 3; ctx.strokeRect(o.x, o.y, o.w, o.h); ctx.restore();
  }
}

export function drawEmitter(ctx, e, t = 0) {
  const u = dirFromDeg(e.angle);
  ctx.save();
  ctx.translate(e.x, e.y);
  ctx.shadowColor = CYAN; ctx.shadowBlur = 24;
  ctx.fillStyle = '#10243f'; ctx.strokeStyle = CYAN; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(0, 0, 22, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.lineWidth = 12; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(u.x * 34, u.y * 34); ctx.stroke();
  ctx.restore();
  txt(ctx, 'LASER', e.x, e.y + 44, { size: 14, color: CYAN, alpha: 0.8 });
}

/** 거울: 손 거울(굵은 시안, 손 상태 표시) / 고정 거울(보라) / 유령(정답 예시) */
export function drawMirror(ctx, m, { label = '', tracked = false, active = false, ghost = false, t = 0, showAngle = true } = {}) {
  const [a, b] = mirrorEnds(m);
  const hand = m.kind === 'hand';
  ctx.save();
  ctx.lineCap = 'round';
  if (ghost) {
    ctx.setLineDash([10, 10]); ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = 6; ctx.globalAlpha = 0.9;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.restore();
    txt(ctx, `${Math.round(norm180(m.angle))}°`, m.x, m.y - 40, { size: 22, color: '#ffd23f' });
    return;
  }
  const color = hand ? CYAN : '#9a8cff';
  ctx.shadowColor = color; ctx.shadowBlur = hand ? 22 : 12;
  ctx.strokeStyle = color; ctx.lineWidth = hand ? 10 : 7;
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  ctx.shadowBlur = 0; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = hand ? 3 : 2;
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  ctx.fillStyle = '#0a1426'; ctx.strokeStyle = color; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(m.x, m.y, 8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  if (hand && active) { ctx.setLineDash([6, 6]); ctx.beginPath(); ctx.arc(m.x, m.y, 100 + Math.sin(t * 6) * 3, 0, Math.PI * 2); ctx.stroke(); }
  ctx.restore();
  if (hand) {
    // 손 상태 배지: 왼손/오른손 + 각도 (손이 보이면 초록 점)
    const y = m.y + 92;
    panel(ctx, m.x - 78, y - 20, 156, 40, { fill: 'rgba(8,16,34,0.9)', stroke: tracked ? '#5dff9d' : 'rgba(150,170,200,0.5)', r: 12 });
    ctx.save(); ctx.fillStyle = tracked ? '#5dff9d' : '#667799'; ctx.beginPath(); ctx.arc(m.x - 62, y, 5, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    txt(ctx, label, m.x - 46, y, { size: 17, align: 'left', color: tracked ? '#e8f6ff' : '#8a9bbd' });
    if (showAngle) txt(ctx, `${Math.round(norm180(m.angle))}°`, m.x + 70, y, { size: 19, align: 'right', color: CYAN });
  }
}

export function drawTarget(ctx, tg, { activated = false, isNext = false, t = 0, showNumber = true, flash = 0, wrong = 0 } = {}) {
  const color = COLORS[tg.color] || '#fff';
  ctx.save();
  ctx.translate(tg.x, tg.y);
  const pulse = 1 + Math.sin(t * 5) * 0.04;
  ctx.shadowColor = color; ctx.shadowBlur = activated ? 40 : 16;
  if (activated) {
    ctx.fillStyle = color; ctx.globalAlpha = 0.9;
    ctx.beginPath(); ctx.arc(0, 0, tg.r * 0.9, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.lineWidth = 5; ctx.strokeStyle = color;
  ctx.beginPath(); ctx.arc(0, 0, tg.r, 0, Math.PI * 2); ctx.stroke();
  if (!activated) {
    ctx.lineWidth = 2; ctx.globalAlpha = 0.55;
    ctx.beginPath(); ctx.arc(0, 0, tg.r * 0.55, 0, Math.PI * 2); ctx.stroke();
  }
  if (isNext && !activated) {                                         // 다음에 맞힐 타깃: 바깥 고리가 숨 쉬듯
    ctx.globalAlpha = 0.5 + Math.sin(t * 6) * 0.3; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(0, 0, tg.r * 1.28 * pulse, 0, Math.PI * 2); ctx.stroke();
  }
  if (flash > 0) { ctx.globalAlpha = flash; ctx.lineWidth = 8; ctx.strokeStyle = '#fff'; ctx.beginPath(); ctx.arc(0, 0, tg.r * (1 + (1 - flash) * 0.9), 0, Math.PI * 2); ctx.stroke(); }
  if (wrong > 0) { ctx.globalAlpha = wrong; ctx.strokeStyle = '#ff4d6d'; ctx.lineWidth = 7; ctx.beginPath(); ctx.moveTo(-tg.r * .6, -tg.r * .6); ctx.lineTo(tg.r * .6, tg.r * .6); ctx.moveTo(tg.r * .6, -tg.r * .6); ctx.lineTo(-tg.r * .6, tg.r * .6); ctx.stroke(); }
  ctx.restore();
  if (showNumber) txt(ctx, activated ? '✓' : String(tg.order + 1), tg.x, tg.y + 1, { size: activated ? 34 : 28, color: activated ? '#06101f' : color, glow: activated ? null : color });
}

/** 레이저 경로. upTo: 시작점에서 이 거리(px)까지만. 처음엔 굵은 빛줄기 + 하얀 심 */
export function drawPath(ctx, segments, { upTo = Infinity, color = CYAN, width = 7, alpha = 1, dash = null, core = true, glow = 20 } = {}) {
  let left = upTo;
  const pts = [];
  for (const s of segments) {
    if (left <= 0) break;
    const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
    const f = Math.min(1, left / len);
    if (!pts.length) pts.push({ x: s.x1, y: s.y1 });
    pts.push({ x: s.x1 + (s.x2 - s.x1) * f, y: s.y1 + (s.y2 - s.y1) * f });
    left -= len;
    if (f < 1) break;
  }
  if (pts.length < 2) return pts[pts.length - 1] || null;
  ctx.save();
  ctx.globalAlpha *= alpha; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (dash) ctx.setLineDash(dash);
  const path = () => { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.stroke(); };
  ctx.shadowColor = color; ctx.shadowBlur = glow; ctx.strokeStyle = color; ctx.lineWidth = width; path();
  if (core) { ctx.shadowBlur = 0; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(1.5, width * 0.4); path(); }
  ctx.restore();
  return pts[pts.length - 1];
}

/** 원리 설명: 첫 반사점에 법선과 입사각·반사각을 그림 (튜토리얼) */
export function drawPrinciple(ctx, tr, t = 0) {
  const s0 = tr.segments[0], s1 = tr.segments[1];
  if (!s0 || !s1 || !s0.mirrorId) return;
  const P = { x: s0.x2, y: s0.y2 };
  const din = { x: (s0.x2 - s0.x1), y: (s0.y2 - s0.y1) }, lin = Math.hypot(din.x, din.y); din.x /= lin; din.y /= lin;
  const dout = { x: (s1.x2 - s1.x1), y: (s1.y2 - s1.y1) }, lout = Math.hypot(dout.x, dout.y); dout.x /= lout; dout.y /= lout;
  // 법선: 들어오는 빛의 반대쪽(= 빛이 오는 쪽)을 향하게
  let n = { x: dout.x - din.x, y: dout.y - din.y }; const ln = Math.hypot(n.x, n.y);
  if (ln < 1e-6) return;
  n = { x: n.x / ln, y: n.y / ln };
  const theta = deg(Math.acos(Math.max(-1, Math.min(1, dout.x * n.x + dout.y * n.y))));
  ctx.save();
  ctx.setLineDash([8, 8]); ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(P.x - n.x * 70, P.y - n.y * 70); ctx.lineTo(P.x + n.x * 120, P.y + n.y * 120); ctx.stroke();
  ctx.setLineDash([]);
  const an = Math.atan2(n.y, n.x), ai = Math.atan2(-din.y, -din.x), ao = Math.atan2(dout.y, dout.x);
  const arc = (a2, color) => {
    let d = a2 - an; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
    ctx.strokeStyle = color; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(P.x, P.y, 56, an, an + d, d < 0); ctx.stroke();
    const mid = an + d / 2; return { x: P.x + Math.cos(mid) * 92, y: P.y + Math.sin(mid) * 92 };
  };
  const li = arc(ai, '#ffd23f'), lo = arc(ao, '#ff7ad9');
  ctx.restore();
  txt(ctx, `입사각 ${theta.toFixed(0)}°`, li.x, li.y, { size: 20, color: '#ffd23f' });
  txt(ctx, `반사각 ${theta.toFixed(0)}°`, lo.x, lo.y, { size: 20, color: '#ff7ad9' });
}

export function drawParticles(ctx, parts) {
  ctx.save();
  for (const p of parts) {
    const a = Math.max(0, p.life / p.max);
    ctx.globalAlpha = a; ctx.fillStyle = p.color; ctx.shadowColor = p.color; ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (0.4 + 0.6 * a), 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}
