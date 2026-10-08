const tg = window.Telegram?.WebApp;
const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
function resolveGameId() {
  const q = params.get('game');
  if (q) return q;
  const sp = tg?.initDataUnsafe?.start_param;
  if (sp && sp.startsWith('game_')) return sp.slice(5);
  return sp || '';
}
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&','<':'<','>':'>','"':'"',"'":'&#39;'}[c]));
const notice = t => { const el = $('notice'); el.textContent = t || ''; if (t) setTimeout(() => { if (el.textContent === t) el.textContent = ''; }, 4000); };

let socket, lastSnap, currentGameId, viewerId;
let myViewer = null; // 由 /api/games?initData 首次拿到；WS 广播不含 viewer，避免被覆盖
let perspectiveKey = localStorage.getItem('perspective') || 'player';
$('perspectiveToggle').checked = perspectiveKey === 'admin';
$('perspectiveToggle').addEventListener('change', e => {
  perspectiveKey = e.target.checked ? 'admin' : 'player';
  localStorage.setItem('perspective', perspectiveKey);
  render(lastSnap);
});

function viewerLabel(p) { return p?.label || `用户 #${String(p?.userId || '').slice(-4)}`; }

async function api(path, method, body) {
  const initData = tg?.initData || params.get('initData') || '';
  const url = `${path}${path.includes('?') ? '&' : '?'}initData=${encodeURIComponent(initData)}`;
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Error(data.error || '请求失败');
  return data;
}

function render(snap) {
  lastSnap = snap;
  if (!snap) { $('title').textContent = '尚未开启对局'; $('subtitle').textContent = '请管理员在群里 /startgame'; return; }
  if (snap.viewer) myViewer = snap.viewer;
  const viewer = myViewer || { id: 0, isAdmin: false };
  viewerId = viewer.id;
  const showAdmin = viewer.isAdmin && perspectiveKey === 'admin';
  $('perspectiveWrap').hidden = !viewer.isAdmin;
  $('title').textContent = snap.rule?.name || '游戏';
  $('subtitle').textContent = snap.status === 'signup' ? '🎲 报名中'
    : snap.status === 'ended' ? '✅ 已结束'
    : '🎮 进行中';

  const stepCard = $('stepCard');
  const loopBadge = (snap) => {
    const lp = snap.loopProgress;
    if (!lp) return '';
    return lp.total === null
      ? `<span class="loop-badge">🔁 第 ${lp.current} 轮（无限）</span>`
      : `<span class="loop-badge">🔁 第 ${lp.current} / ${lp.total} 轮</span>`;
  };
  const roundName = snap.rule?.rounds?.[snap.roundIdx]?.name || `第 ${snap.roundIdx + 1} 轮`;
  if (snap.status === 'signup') {
    stepCard.hidden = false;
    $('roundName').textContent = '报名阶段';
    $('stepLabel').textContent = '';
    $('stepBody').innerHTML = '等待玩家点击 <b>加入</b>，管理员点 <b>开始</b>。';
  } else if (snap.phase.kind === 'roll') {
    stepCard.hidden = false;
    $('roundName').textContent = roundName;
    $('stepLabel').innerHTML = `${esc(snap.phase.stepLabel || '等待色子')} ${loopBadge(snap)}`;
    const expectedId = snap.phase.expectedPlayerId;
    const expected = snap.players.find(p => p.userId === expectedId);
    $('stepBody').innerHTML = expected
      ? `等待 <b>${esc(viewerLabel(expected))}</b> 发 🎲`
      : '等待任一玩家发 🎲';
  } else if (snap.phase.kind === 'text') {
    stepCard.hidden = false;
    $('roundName').textContent = roundName;
    $('stepLabel').innerHTML = `${esc(snap.phase.stepLabel || '问答')} ${loopBadge(snap)}`;
    $('stepBody').textContent = snap.phase.text;
  } else if (snap.phase.kind === 'punish') {
    stepCard.hidden = false;
    $('roundName').textContent = roundName;
    $('stepLabel').innerHTML = `${esc(snap.phase.stepLabel || '惩罚')} ${loopBadge(snap)}`;
    $('stepBody').innerHTML = `🎯 ${esc(snap.phase.text)} <span class="hit">（第 ${snap.phase.hitCount} 次）</span>`;
  } else if (snap.phase.kind === 'choice') {
    stepCard.hidden = false;
    $('roundName').textContent = roundName;
    $('stepLabel').innerHTML = `${esc(snap.phase.stepLabel || '选择')} ${loopBadge(snap)}`;
    const pickedBy = snap.phase.pickedBy;
    const picker = pickedBy ? snap.players.find(p => p.userId === pickedBy) : null;
    const head = picker
      ? `等待 <b>${esc(viewerLabel(picker))}</b> 选择：`
      : '请选择：';
    const list = (snap.phase.options || []).map((o, i) =>
      `<li>${i + 1}. ${esc(o.text)}</li>`
    ).join('');
    $('stepBody').innerHTML = `${head}<ol class="choice-options">${list}</ol>`;
  } else if (snap.phase.kind === 'showdown') {
    stepCard.hidden = false;
    $('roundName').textContent = roundName;
    $('stepLabel').innerHTML = `${esc(snap.phase.stepLabel || '比大小')} ${loopBadge(snap)}`;
    const mode = snap.phase.order === 'low' ? '比小' : snap.phase.order === 'high' ? '比大' : '收集';
    const rolls = snap.phase.rolls || [];
    const pending = snap.phase.pending || [];
    const rolledRows = rolls.map(r => {
      const p = snap.players.find(pp => pp.userId === r.userId);
      return `<li>✅ ${esc(viewerLabel(p))} → <b>${r.value}</b></li>`;
    }).join('');
    const pendingRows = pending.map(id => {
      const p = snap.players.find(pp => pp.userId === id);
      return `<li>⏳ ${esc(viewerLabel(p))}</li>`;
    }).join('');
    $('stepBody').innerHTML = `${snap.phase.emoji} ${mode} · 已掷 <b>${rolls.length}</b>/${snap.phase.total}<ul class="choice-options">${rolledRows}${pendingRows}</ul>`;
  } else {
    stepCard.hidden = true;
  }

  if (snap.lastDice) {
    $('diceCard').hidden = false;
    $('diceBox').textContent = '🎲';
    $('diceBox').dataset.value = String(snap.lastDice.value);
    $('diceBox').classList.remove('rolling');
    void $('diceBox').offsetWidth;
    $('diceBox').classList.add('rolling');
    const roller = snap.players.find(p => p.userId === snap.lastDice.userId);
    let meta = `${esc(viewerLabel(roller))} 掷出 <b>${snap.lastDice.value}</b>`;
    if (snap.lastDice.decoded) {
      const d = snap.lastDice.decoded;
      const labels = { bar: 'BAR', berries: '🍓', lemon: '🍋', seven: '7' };
      meta += ` · ${labels[d.r1]} ${labels[d.r2]} ${labels[d.r3]}${d.jackpot ? ' 🎉 JACKPOT' : ''}`;
    }
    $('diceMeta').innerHTML = meta;
  } else {
    $('diceCard').hidden = true;
  }

  const playersList = $('playerList');
  playersList.innerHTML = snap.players.length
    ? snap.players.map(p => {
        const isMe = p.userId === viewerId;
        const isPending = snap.phase.kind === 'showdown' && (snap.phase.pending || []).includes(p.userId);
        const isExpected = (snap.phase.kind === 'roll' && snap.phase.expectedPlayerId === p.userId) || isPending;
        return `<li class="${isMe ? 'me' : ''} ${isExpected ? 'expected' : ''}">${esc(p.label)}${isExpected ? ' 🎯' : ''}${isMe ? ' (你)' : ''}</li>`;
      }).join('')
    : '<li class="empty">暂无玩家</li>';
  $('playerCountNum').textContent = String(snap.players.length);
  $('players').hidden = false;

  const actions = $('actions');
  const buttons = [];
  if (snap.status === 'signup') {
    if (!snap.players.some(p => p.userId === viewerId)) {
      buttons.push({ label: '加入对局', action: 'join', kind: 'primary' });
    } else {
      buttons.push({ label: '退出报名', action: 'leave', kind: 'secondary' });
    }
    if (showAdmin && snap.players.length > 0) {
      buttons.push({ label: '▶ 开始', action: 'begin', kind: 'admin' });
    }
  } else if (snap.status === 'in_progress') {
    if (snap.phase.kind === 'roll' || snap.phase.kind === 'showdown') {
      const isPlayer = snap.players.some(p => p.userId === viewerId);
      let canThrow = false;
      if (snap.phase.kind === 'roll') {
        canThrow = snap.phase.expectedPlayerId === viewerId || snap.phase.expectedPlayerId === null;
      } else {
        canThrow = isPlayer && !(snap.phase.rolls || []).some(r => r.userId === viewerId);
      }
      if (canThrow && isPlayer) buttons.push({ label: `${snap.phase.emoji} 我扔（点我去群内发）`, action: 'throw', kind: 'primary' });
    }
    if (showAdmin) {
      if (snap.phase.kind === 'text' || snap.phase.kind === 'punish') {
        buttons.push({ label: '下一步', action: 'next', kind: 'admin' });
        buttons.push({ label: '跳过', action: 'skip', kind: 'admin' });
      }
      if (snap.phase.kind === 'showdown') {
        buttons.push({ label: '立即结算', action: 'next', kind: 'admin' });
        buttons.push({ label: '跳过', action: 'skip', kind: 'admin' });
      }
      buttons.push({ label: '撤销', action: 'undo', kind: 'admin' });
      buttons.push({ label: '结束', action: 'end', kind: 'danger' });
    }
    if (snap.phase.kind === 'choice') {
      const canPick = snap.phase.pickedBy === null || snap.phase.pickedBy === viewerId;
      if (canPick) {
        (snap.phase.options || []).forEach((o, i) => {
          buttons.push({ label: o.text, action: `choice:${i}`, kind: 'primary' });
        });
      }
    }
  }
  actions.hidden = buttons.length === 0;
  $('actionButtons').innerHTML = buttons.map((b, i) =>
    `<button data-i="${i}" class="btn ${b.kind}">${b.label}</button>`
  ).join('');
  $('actionButtons').onclick = e => {
    const idx = e.target.dataset?.i;
    if (idx === undefined) return;
    const b = buttons[Number(idx)];
    if (b.action === 'throw') { tg?.openTelegramLink?.(`https://t.me/c/${snap.chatId}`); return; }
    if (b.action.startsWith('choice:')) {
      const optIdx = Number(b.action.slice(7));
      api(`/api/games/${snap.gameId}/choice`, 'POST', JSON.stringify({ optionIdx: optIdx })).then(render).catch(e => notice(e.message));
      return;
    }
    api(`/api/games/${snap.gameId}/${b.action}`, 'POST').then(render).catch(e => notice(e.message));
  };
  $('footer').textContent = showAdmin ? '管理员视角' : '玩家视角';
}

async function loadInitial() {
  const initData = tg?.initData || params.get('initData') || '';
  const gameId = resolveGameId();
  if (!gameId) { notice('缺少 game 参数'); return; }
  currentGameId = gameId;
  const snap = await fetch(`/api/games/${gameId}?initData=${encodeURIComponent(initData)}`).then(r => r.json());
  if (snap.error) { notice(snap.error); return; }
  render(snap);
  connect();
}

function connect() {
  const initData = tg?.initData || params.get('initData') || '';
  if (!initData) {
    notice('无法获取 Telegram 登录信息（initData 为空）。请从 Telegram 内打开此页面，不要直接在浏览器打开。');
    return;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${location.host}/ws?game=${currentGameId}&initData=${encodeURIComponent(initData)}`);
  socket.onmessage = e => {
    const packet = JSON.parse(e.data);
    if (packet.type === 'state') render(packet.snapshot);
  };
  socket.onerror = () => notice('连接出错');
  socket.onclose = e => {
    if (e.code !== 1000 && e.code !== 1005) notice(`连接断开（code=${e.code}），5 秒后重连`);
    setTimeout(connect, 5000);
  };
}

tg?.ready();
tg?.expand();

const debug = $('debug');
function updateDebug() {
  if (!debug) return;
  const hasTg = !!tg;
  const initDataLen = (tg?.initData || '').length;
  const startParam = tg?.initDataUnsafe?.start_param || '';
  const plat = tg?.platform || '(no tg)';
  const proto = location.protocol;
  debug.textContent = `tg=${hasTg} platform=${plat} initDataLen=${initDataLen} startParam=${startParam} proto=${proto}`;
}
updateDebug();

loadInitial().catch(e => { $('title').textContent = '无法连接'; notice(e.message); });
