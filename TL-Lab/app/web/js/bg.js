// Анімований фон: «цифровий дощ» або радар (canvas позаду вмісту). Режим — window.__tlbg = {mode, k}.

(function(){
  const app = () => document.body;
  let c = document.getElementById('tl-bg');
  if (!c) { c = document.createElement('canvas'); c.id = 'tl-bg'; app().prepend(c); }
  Object.assign(c.style, {position:'fixed', inset:'0', width:'100vw', height:'100vh', zIndex:'0', pointerEvents:'none'});
  const ctx = c.getContext('2d');
  const FS = 16;
  const CH = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホ0101ЖЗИЙКЛФЦЧШЩЮЯ0123456789ABCDEF<>/{}[]#$%&';
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let W, H, cols, drops, speed, active, last = 0, ang = 0, blips = [], prevMode = '';

  function resize(){
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    c.width = W * dpr; c.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.ceil(W / FS);
    drops = Array.from({length: cols}, () => Math.random() * -H / FS);
    speed = Array.from({length: cols}, () => 0.45 + Math.random() * 0.75);
    active = Array.from({length: cols}, () => Math.random());
    ctx.fillStyle = '#05070a'; ctx.fillRect(0, 0, W, H);
  }
  resize(); addEventListener('resize', resize);

  function matrix(k){
    ctx.fillStyle = 'rgba(5,7,10,0.10)'; ctx.fillRect(0, 0, W, H);
    ctx.font = FS + 'px Consolas, "DejaVu Sans Mono", monospace';
    for (let i = 0; i < cols; i++) {
      if (active[i] > 0.25 + 0.75 * k) continue;          // щільність колонок залежить від інтенсивності
      const ch = CH[(Math.random() * CH.length) | 0];
      const x = i * FS, y = drops[i] * FS;
      ctx.fillStyle = Math.random() < 0.04 ? '#e6fdff' : 'rgba(0,229,255,0.85)';
      ctx.fillText(ch, x, y);
      if (y > H && Math.random() > 0.975) drops[i] = 0;
      drops[i] += speed[i];
    }
  }

  function radar(k){
    ctx.fillStyle = 'rgba(5,7,10,0.18)'; ctx.fillRect(0, 0, W, H);
    const cx = W * 0.70, cy = H * 0.58, R = Math.min(W, H) * 0.42;
    ctx.strokeStyle = 'rgba(0,229,255,0.18)'; ctx.lineWidth = 1;
    for (let r = R / 4; r <= R + 1; r += R / 4) { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
    ang = (ang + 0.035) % (Math.PI * 2);
    for (let j = 0; j < 26; j++) {                          // промінь зі шлейфом
      const a = ang - j * 0.018;
      ctx.strokeStyle = `rgba(0,229,255,${(0.55 * (1 - j / 26)).toFixed(3)})`;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); ctx.stroke();
    }
    if (Math.random() < 0.06 * k) {                          // нова «засічка» там, де пройшов промінь
      const rr = R * (0.15 + Math.random() * 0.8);
      blips.push({x: cx + Math.cos(ang) * rr, y: cy + Math.sin(ang) * rr, life: 1});
    }
    blips = blips.filter(b => (b.life -= 0.012) > 0);
    for (const b of blips) {
      ctx.fillStyle = `rgba(57,255,154,${b.life.toFixed(3)})`;
      ctx.beginPath(); ctx.arc(b.x, b.y, 3, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = `rgba(57,255,154,${(b.life * 0.4).toFixed(3)})`;
      ctx.beginPath(); ctx.arc(b.x, b.y, 3 + (1 - b.life) * 14, 0, Math.PI * 2); ctx.stroke();
    }
  }

  function loop(t){
    requestAnimationFrame(loop);
    const s = window.__tlbg || {mode: 'matrix', k: 0.5};
    if (!c.isConnected) app().prepend(c);
    if (s.mode === 'off') { c.style.display = 'none'; prevMode = 'off'; return; }
    c.style.display = 'block';
    c.style.opacity = (0.25 + 0.6 * s.k).toFixed(2);
    if (s.mode !== prevMode) { ctx.fillStyle = '#05070a'; ctx.fillRect(0, 0, W, H); prevMode = s.mode; }
    if (document.hidden || t - last < 50) return;            // ~20 кадрів/с, пауза у фоновій вкладці
    if (reduce && last) return;                              // без руху: один статичний кадр
    last = t;
    (s.mode === 'radar' ? radar : matrix)(s.k);
  }
  requestAnimationFrame(loop);
})();
