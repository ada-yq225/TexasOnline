const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);

const state = {
  ws: null,
  roomId: new URLSearchParams(location.search).get("room") || "",
  playerId: localStorage.getItem("holdemPlayerId") || "",
  name: localStorage.getItem("holdemName") || "",
  snapshot: null,
  view: "lobby", // "lobby" | "table"
  showdownDismissed: false,
  soundEnabled: true
};

// ===== Sound Effects (Web Audio API) =====
let audioCtx = null;

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function playTone(freq, duration, type = "sine", volume = 0.08) {
  if (!state.soundEnabled) return;
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  } catch {}
}

function playCardSound() {
  playTone(800, 0.06, "triangle", 0.05);
  setTimeout(() => playTone(1000, 0.05, "triangle", 0.04), 50);
}

function playChipSound() {
  playTone(600, 0.07, "square", 0.04);
  setTimeout(() => playTone(800, 0.05, "square", 0.03), 60);
}

function playFoldSound() {
  playTone(200, 0.12, "sine", 0.06);
}

function playWinSound() {
  playTone(523, 0.12, "sine", 0.08);
  setTimeout(() => playTone(659, 0.12, "sine", 0.07), 120);
  setTimeout(() => playTone(784, 0.2, "sine", 0.08), 240);
}

function playTurnSound() {
  playTone(440, 0.08, "triangle", 0.06);
}

function playAllInSound() {
  playTone(300, 0.1, "sawtooth", 0.04);
  setTimeout(() => playTone(500, 0.15, "sawtooth", 0.05), 80);
}

const phaseName = {
  lobby: "大厅",
  preflop: "翻牌前",
  flop: "翻牌圈",
  turn: "转牌圈",
  river: "河牌圈",
  showdown: "摊牌"
};

const suitGlyph = { s: "♠", h: "♥", d: "♦", c: "♣" };
const rankChars = "23456789TJQKA".split("");

function showToast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    el.hidden = true;
  }, 2600);
}

async function ensureRoom() {
  if (state.roomId) return;
  const res = await fetch("/api/room");
  const data = await res.json();
  state.roomId = data.roomId;
  history.replaceState(null, "", `/?room=${state.roomId}`);
}

function connect() {
  if (state.ws) {
    try { state.ws.close(); } catch {}
  }
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  state.ws = new WebSocket(`${protocol}://${location.host}`);
  state.ws.addEventListener("open", () => {
    if (state.name && state.roomId) join();
    if (state.view === "table") renderTop();
  });
  state.ws.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);
    if (data.type === "hello") {
      state.playerId = data.playerId;
      state.roomId = data.roomId;
      localStorage.setItem("holdemPlayerId", state.playerId);
      history.replaceState(null, "", `/?room=${state.roomId}`);
    }
    if (data.type === "state") {
      state.snapshot = data;
      render();
      // Show showdown overlay ONLY when we're in table view
      if (state.view === "table" && data.showdownResult && data.phase === "showdown" && !state.showdownDismissed) {
        showShowdownOverlay(data.showdownResult);
      }
    }
    if (data.type === "chat") {
      appendChatMessage(data);
    }
    if (data.type === "toast") showToast(data.message);
  });
  state.ws.addEventListener("close", () => {
    if (state.view === "table") {
      const turnEl = $("#turnText");
      if (turnEl) turnEl.textContent = "连接已断开，正在重连...";
      setTimeout(connect, 900);
    }
  });
}

function join() {
  state.ws?.send(JSON.stringify({ type: "join", roomId: state.roomId, playerId: state.playerId, name: state.name }));
}

function send(payload) {
  if (state.ws?.readyState !== WebSocket.OPEN) return showToast("正在连接牌桌");
  state.ws.send(JSON.stringify({ roomId: state.roomId, ...payload }));
}

// ==================== Lobby View ====================

async function showLobby() {
  state.view = "lobby";
  state.roomId = "";
  state.showdownDismissed = false;
  hideShowdownOverlay();
  $("#lobbyView").style.display = "grid";
  $("#tableView").style.display = "none";
  $("#showdownOverlay").hidden = true;
  $("#lobbyNameInput").value = state.name;
  history.replaceState(null, "", "/");
  if (state.ws) { try { state.ws.close(); } catch {} state.ws = null; }
  await loadRoomList();
}

function showTable() {
  if (!state.roomId) return showLobby();
  state.view = "table";
  state.showdownDismissed = false;
  hideShowdownOverlay();
  $("#showdownOverlay").hidden = true;
  $("#lobbyView").style.display = "none";
  $("#tableView").style.display = "grid";
  renderTop();
  if (state.name && state.ws?.readyState === WebSocket.OPEN) {
    join();
  }
}

async function loadRoomList() {
  const list = $("#roomList");
  try {
    const res = await fetch("/api/rooms");
    const rooms = await res.json();
    if (!rooms.length) {
      list.innerHTML = '<p class="room-empty">暂无可用房间，快创建一个吧</p>';
      return;
    }
    list.innerHTML = rooms.map((r) => {
      const isPlaying = r.phase !== "lobby" && r.phase !== "showdown";
      const badgeClass = isPlaying ? "playing" : "";
      const badgeText = isPlaying ? "游戏中" : `${r.playerCount}/6 人`;
      return `
        <div class="room-card" data-room="${r.id}">
          <div class="room-card-info">
            <h3>房间 ${r.id}</h3>
            <p>${r.smallBlind}/${r.bigBlind} · 买入 ${r.buyIn}${r.handNumber ? ` · 第 ${r.handNumber} 手` : ""}</p>
          </div>
          <span class="room-card-badge ${badgeClass}">${badgeText}</span>
        </div>
      `;
    }).join("");
    list.querySelectorAll(".room-card").forEach((card) => {
      card.addEventListener("click", () => {
        const roomId = card.dataset.room;
        state.roomId = roomId;
        history.replaceState(null, "", `/?room=${roomId}`);
        showTable();
        connect();
      });
    });
  } catch {
    list.innerHTML = '<p class="room-empty">无法加载房间列表</p>';
  }
}

// ==================== Table View ====================

function renderTop() {
  const snap = state.snapshot;
  const detail = snap ? ` · ${snap.smallBlind}/${snap.bigBlind} · 买入 ${snap.buyIn}` : "";
  $("#roomLine").textContent = state.roomId ? `房间 ${state.roomId}${detail}` : "正在创建房间...";
  $("#nameInput").value = state.name;
}

function render() {
  const snap = state.snapshot;
  if (!snap) return;
  const prev = state._prevSnap;
  renderTop();
  const isMe = snap.players.find((p) => p.id === snap.viewerId);
  $("#joinPanel").style.display = state.name && isMe ? "none" : "flex";
  $("#potValue").textContent = snap.pot;
  $("#phaseText").textContent = phaseName[snap.phase] || snap.phase;
  const turnPlayer = snap.players.find((p) => p.seat === snap.turnSeat);
  $("#turnText").textContent = turnPlayer ? `轮到 ${turnPlayer.name}` : snap.phase === "lobby" ? "等待玩家加入" : "等待下一手";
  renderBoard(snap.board);
  renderPlayers(snap);
  renderLog(snap.log);
  renderSettings(snap);
  renderControls(snap);
  renderChat(snap.chat);
  // Reset showdown dismiss when entering new phase
  if (snap.phase !== "showdown") state.showdownDismissed = false;
  // Auto-show overlay when showdown result arrives
  if (snap.showdownResult && snap.phase === "showdown" && !state.showdownDismissed) {
    showShowdownOverlay(snap.showdownResult);
  }
  // Sound effects based on state changes
  if (prev) {
    const prevPot = prev.pot;
    const prevBoardLen = prev.board?.length || 0;
    const curBoardLen = snap.board?.length || 0;
    const prevPhase = prev.phase;
    // Board cards dealt (flop/turn/river)
    if (curBoardLen > prevBoardLen) {
      playCardSound();
      if (curBoardLen > prevBoardLen + 1) { setTimeout(() => playCardSound(), 120); setTimeout(() => playCardSound(), 240); }
    }
    // Pot increased (someone bet/called/raised)
    if (snap.pot > prevPot && snap.phase !== "showdown") {
      const diff = snap.pot - prevPot;
      if (diff >= snap.bigBlind * 5) playAllInSound();
      else playChipSound();
    }
    // Showdown / win
    if (snap.phase === "showdown" && prevPhase !== "showdown" && snap.showdownResult) {
      playWinSound();
    }
    // Fold detection: a player is now folded
    if (snap.turnSeat !== prev.turnSeat && snap.phase !== "lobby" && snap.phase !== "showdown") {
      const prevMe = prev.players?.find((p) => p.id === snap.viewerId);
      const curMe = snap.players?.find((p) => p.id === snap.viewerId);
      if (curMe?.seat === snap.turnSeat && !prevMe?.folded && !curMe?.folded) {
        playTurnSound();
      }
    }
  }
  state._prevSnap = { pot: snap.pot, board: [...snap.board], phase: snap.phase, turnSeat: snap.turnSeat, players: snap.players.map((p) => ({ id: p.id, folded: p.folded, seat: p.seat })), bigBlind: snap.bigBlind };
}

function renderBoard(cards) {
  const board = $("#board");
  board.innerHTML = "";
  for (let i = 0; i < 5; i += 1) board.append(cardEl(cards[i]));
}

function renderPlayers(snap) {
  const wrap = $("#players");
  wrap.innerHTML = "";
  snap.players.forEach((p) => {
    const seat = document.createElement("article");
    seat.className = `seat seat-${p.seat}${p.seat === snap.turnSeat ? " turn" : ""}${p.folded ? " folded" : ""}`;
    const st = p.stats || {};
    const winRate = st.handsPlayed > 0 ? Math.round((st.handsWon / st.handsPlayed) * 100) : 0;
    const vpip = st.vpipHands > 0 ? Math.round((st.vpipCount / st.vpipHands) * 100) : 0;
    const profit = st.totalProfit || 0;
    const profitStr = profit > 0 ? `+${profit}` : `${profit}`;
    const profitClass = profit > 0 ? "profit-up" : profit < 0 ? "profit-down" : "";
    let posBadge = "";
    if (p.seat === snap.dealer) posBadge = '<span class="badge dealer">D</span>';
    else if (p.seat === snap.sbSeat) posBadge = '<span class="badge sb">SB</span>';
    else if (p.seat === snap.bbSeat) posBadge = '<span class="badge bb">BB</span>';
    seat.innerHTML = `
      <div class="player-head">
        <span class="name">${escapeHtml(p.name)}</span>
        ${p.isHost ? '<span class="badge">房</span>' : ""}
        ${posBadge}
      </div>
      <div class="cards"></div>
      <div class="chips">
        <span>筹码 ${p.chips}</span>
        <span class="bet">${p.bet ? `本轮 ${p.bet}` : p.allIn ? "All in" : p.folded ? "已弃牌" : ""}</span>
      </div>
      <div class="committed">${p.committed ? `已投入 ${p.committed}` : p.connected ? "在线" : "离线"}</div>
      <div class="player-stats">
        <span title="胜率">🏆${winRate}%</span>
        <span title="入池率">💰${vpip}%</span>
        <span class="${profitClass}" title="总收益">📈${profitStr}</span>
      </div>
    `;
    const cards = seat.querySelector(".cards");
    (p.cards.length ? p.cards : [null, null]).forEach((card) => cards.append(cardEl(card)));
    wrap.append(seat);
  });
}

function cardEl(card) {
  const el = document.createElement("div");
  if (!card) {
    el.className = "card back";
    el.textContent = " ";
    return el;
  }
  const rank = card[0] === "T" ? "10" : card[0];
  const suit = card[1];
  el.className = `card ${suit === "h" || suit === "d" ? "red" : ""}`;
  el.textContent = `${rank}${suitGlyph[suit]}`;
  return el;
}

function renderLog(items) {
  const list = $("#logList");
  list.innerHTML = "";
  items.slice().reverse().forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item;
    list.append(li);
  });
}

function renderSettings(snap) {
  const isHost = snap.hostId === snap.viewerId;
  const editable = isHost && (snap.phase === "lobby" || snap.phase === "showdown");
  $("#smallBlindInput").value = snap.smallBlind;
  $("#bigBlindInput").value = snap.bigBlind;
  $("#buyInInput").value = snap.buyIn;
  $("#maxBuyInInput").value = snap.maxBuyIn;
  $("#settingsForm").querySelectorAll("input, button").forEach((el) => {
    el.disabled = !editable;
  });
}

function renderControls(snap) {
  const me = snap.players.find((p) => p.id === snap.viewerId);
  const isHost = snap.hostId === snap.viewerId;
  const myTurn = me && me.seat === snap.turnSeat;
  const toCall = me ? Math.max(0, snap.currentBet - me.bet) : 0;
  const canBuyIn = Boolean(me) && (snap.phase === "lobby" || snap.phase === "showdown");
  $("#meStack").textContent = me ? `我的筹码 ${me.chips}${toCall ? ` · 需跟 ${toCall}` : ""}` : "未入座";
  $("#startBtn").disabled = !isHost || (snap.phase !== "lobby" && snap.phase !== "showdown") || snap.players.length < 2;
  $("#foldBtn").disabled = !myTurn;
  $("#checkBtn").disabled = !myTurn || toCall > 0;
  $("#callBtn").disabled = !myTurn || toCall === 0;
  $("#callBtn").textContent = toCall > 0 ? `跟注 ${toCall}` : "跟注";
  $("#raiseBtn").disabled = !myTurn;
  $("#rebuyBtn").disabled = !canBuyIn;
  $("#rebuyInput").disabled = !canBuyIn;
  $("#resetRoomBtn").disabled = !isHost || (snap.phase !== "lobby" && snap.phase !== "showdown");
  $("#rebuyInput").min = snap.bigBlind;
  $("#rebuyInput").max = snap.maxBuyIn;
  if (Number($("#rebuyInput").value) < (me?.chips || snap.buyIn)) $("#rebuyInput").value = Math.min(snap.maxBuyIn, Math.max(snap.buyIn, me?.chips || 0));
  const minTo = snap.currentBet + snap.minRaise;
  $("#raiseInput").min = minTo;
  $("#raiseInput").max = me ? me.bet + me.chips : minTo;
  if (Number($("#raiseInput").value) < minTo) $("#raiseInput").value = minTo;
  $$("[data-bet]").forEach((button) => {
    button.disabled = !myTurn;
  });
}

function renderChat(messages) {
  const container = $("#chatMessages");
  if (!container) return;
  // Only render if empty (initial load). New messages come via appendChatMessage.
  if (!container.dataset.initialized) {
    container.innerHTML = "";
    container.dataset.initialized = "1";
    (messages || []).forEach((msg) => appendChatMessage(msg));
  }
}

function appendChatMessage(msg) {
  const container = $("#chatMessages");
  if (!container) return;
  const div = document.createElement("div");
  div.className = "chat-msg";
  div.innerHTML = `<span class="chat-author">${escapeHtml(msg.name)}:</span><span class="chat-text">${escapeHtml(msg.text)}</span>`;
  container.append(div);
  container.scrollTop = container.scrollHeight;
}

// ==================== Showdown Overlay ====================

function showShowdownOverlay(result) {
  state.showdownDismissed = true;
  const overlay = $("#showdownOverlay");
  if (!overlay) return;

  const winnerNames = result.winnerNames.join("、");
  $("#showdownTitle").textContent = "摊牌结算";
  $("#showdownWinner").innerHTML = `
    <div class="winner-animation">🏆 ${winnerNames} 获胜！</div>
    <div class="winner-detail">牌型：${result.winLabel} · 赢得底池 ${result.pot}</div>
  `;

  const playersHtml = result.players.map((p) => {
    const isWinner = result.winners.includes(p.id);
    const cardsHtml = (p.cards || []).map((c) => cardEl(c).outerHTML).join("");
    return `
      <div class="showdown-player ${isWinner ? "winner" : ""}">
        <span class="sp-name">${isWinner ? "🏆 " : ""}${escapeHtml(p.name)}</span>
        <span class="sp-score">${p.scoreLabel}</span>
        <div class="sp-cards">${cardsHtml}</div>
      </div>
    `;
  }).join("");
  $("#showdownPlayers").innerHTML = playersHtml;

  overlay.hidden = false;
}

function hideShowdownOverlay() {
  $("#showdownOverlay").hidden = true;
}

// ==================== Event Bindings ====================

// Lobby events
$("#lobbyNameForm")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = $("#lobbyNameInput").value.trim();
  if (!name) return showToast("先起一个昵称");
  state.name = name;
  localStorage.setItem("holdemName", name);
  showToast("昵称已设置");
  loadRoomList();
});

$("#createRoomBtn")?.addEventListener("click", async () => {
  if (!state.name) return showToast("请先输入昵称");
  localStorage.removeItem("holdemPlayerId");
  state.playerId = "";
  state.roomId = "";
  await ensureRoom();
  showTable();
  connect();
});

// Table events
$("#joinForm")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = $("#nameInput").value.trim();
  if (!name) return showToast("先起一个昵称");
  state.name = name;
  localStorage.setItem("holdemName", name);
  join();
  renderTop();
});

$("#copyLink")?.addEventListener("click", async () => {
  await navigator.clipboard.writeText(location.href);
  showToast("邀请链接已复制");
});

$("#backToLobby")?.addEventListener("click", () => {
  showLobby();
  loadRoomList();
});

$("#leaveRoomBtn")?.addEventListener("click", () => {
  if (!state.snapshot) return;
  const me = state.snapshot.players.find((p) => p.id === state.snapshot.viewerId);
  if (!me) return showToast("你还没有入座");
  send({ type: "leave" });
  state.playerId = "";
  localStorage.removeItem("holdemPlayerId");
  // Reset join panel
  $("#joinPanel").style.display = "flex";
});

$("#resetRoomBtn")?.addEventListener("click", () => {
  send({ type: "resetRoom" });
});

$("#soundToggle")?.addEventListener("click", () => {
  state.soundEnabled = !state.soundEnabled;
  $("#soundToggle").textContent = state.soundEnabled ? "🔊" : "🔇";
});

$("#settingsForm")?.addEventListener("submit", (event) => {
  event.preventDefault();
  send({
    type: "settings",
    smallBlind: Number($("#smallBlindInput").value),
    bigBlind: Number($("#bigBlindInput").value),
    buyIn: Number($("#buyInInput").value),
    maxBuyIn: Number($("#maxBuyInInput").value)
  });
});

$("#rebuyBtn")?.addEventListener("click", () => {
  send({ type: "buyIn", amount: Number($("#rebuyInput").value) });
});

$$("[data-bet]").forEach((button) => {
  button.addEventListener("click", () => {
    const snap = state.snapshot;
    const me = snap?.players.find((p) => p.id === snap.viewerId);
    if (!snap || !me) return;
    const toCall = Math.max(0, snap.currentBet - me.bet);
    const stackTop = me.bet + me.chips;
    const minTo = Math.min(stackTop, snap.currentBet + snap.minRaise);
    const potAfterCall = snap.pot + toCall;
    let target = minTo;
    if (button.dataset.bet === "half") target = snap.currentBet + toCall + Math.ceil(potAfterCall / 2);
    if (button.dataset.bet === "pot") target = snap.currentBet + toCall + potAfterCall;
    if (button.dataset.bet === "allin") {
      $("#raiseInput").value = stackTop;
      return send({ type: "action", action: "allIn" });
    }
    $("#raiseInput").value = Math.max(minTo, Math.min(stackTop, target));
  });
});

$("#startBtn")?.addEventListener("click", () => send({ type: "start" }));
$("#foldBtn")?.addEventListener("click", () => send({ type: "action", action: "fold" }));
$("#checkBtn")?.addEventListener("click", () => send({ type: "action", action: "check" }));
$("#callBtn")?.addEventListener("click", () => send({ type: "action", action: "call" }));
$("#raiseBtn")?.addEventListener("click", () => send({ type: "action", action: "raise", amount: Number($("#raiseInput").value) }));

// Chat
$("#chatForm")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("#chatInput");
  const text = input.value.trim();
  if (!text) return;
  send({ type: "chat", text });
  input.value = "";
});

// Showdown close
$("#showdownClose")?.addEventListener("click", hideShowdownOverlay);
$("#showdownOverlay")?.addEventListener("click", (event) => {
  if (event.target === $("#showdownOverlay")) hideShowdownOverlay();
});

// ==================== Escape HTML ====================

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[m]);
}

// ==================== Init ====================

if (state.roomId && state.name) {
  // Has room and name, go straight to table
  showTable();
  connect();
} else if (state.roomId) {
  // Has room but no name, show table with join panel
  showTable();
  connect();
} else {
  // No room, show lobby (no WebSocket needed yet)
  showLobby();
}
