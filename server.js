import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const rooms = new Map();

const ranks = "23456789TJQKA".split("");
const suits = ["s", "h", "d", "c"];
const rankValue = Object.fromEntries(ranks.map((r, i) => [r, i + 2]));

function id(len = 6) {
  return crypto.randomBytes(12).toString("base64url").replace(/[-_]/g, "").slice(0, len).toUpperCase();
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function send(ws, data) {
  if (!ws) return;
  if (ws.destroyed) return;
  const text = JSON.stringify(data);
  const payload = Buffer.from(text);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  ws.write(Buffer.concat([header, payload]));
}

function readFrames(socket, onMessage) {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const first = buffer[0];
      const second = buffer[1];
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskOffset = masked ? 4 : 0;
      if (buffer.length < offset + maskOffset + length) return;
      const mask = masked ? buffer.subarray(offset, offset + 4) : null;
      offset += maskOffset;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      buffer = buffer.subarray(offset + length);
      if (opcode === 0x8) {
        socket.end();
        return;
      }
      if (opcode === 0x9) {
        socket.write(Buffer.from([0x8a, 0x00]));
        continue;
      }
      if (opcode !== 0x1) continue;
      if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      try {
        onMessage(JSON.parse(payload.toString("utf8")));
      } catch {
        send(socket, { type: "toast", message: "消息格式不正确" });
      }
    }
  });
}

function makeRoom(roomId) {
  return {
    id: roomId,
    seats: [],
    spectators: new Map(),
    hostId: null,
    phase: "lobby",
    deck: [],
    board: [],
    pot: 0,
    dealer: -1,
    smallBlind: 10,
    bigBlind: 20,
    buyIn: 1000,
    maxBuyIn: 5000,
    currentBet: 0,
    minRaise: 20,
    bettingReopened: true,
    reopenBet: 40,
    turnSeat: null,
    lastAggressor: null,
    handNumber: 0,
    log: ["房间已创建，等待朋友加入。"],
    chat: [],
    showdownResult: null,
    stats: {} // playerId -> { handsPlayed, handsWon, vpipHands, vpipCount, totalProfit }
  };
}

function roomById(roomId) {
  const key = String(roomId || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  if (!rooms.has(key)) rooms.set(key, makeRoom(key));
  return rooms.get(key);
}

function publicPlayer(player, viewerId, phase) {
  return {
    id: player.id,
    name: player.name,
    chips: player.chips,
    bet: player.bet,
    committed: player.committed || 0,
    folded: player.folded,
    allIn: player.allIn,
    connected: Boolean(player.ws && !player.ws.destroyed),
    cards: player.id === viewerId || phase === "showdown" ? player.cards : player.cards.map(() => null),
    isHost: false,
    seat: player.seat
  };
}

function stateFor(room, viewerId) {
  return {
    type: "state",
    roomId: room.id,
    viewerId,
    hostId: room.hostId,
    phase: room.phase,
    board: room.board,
    pot: room.pot,
    currentBet: room.currentBet,
    minRaise: room.minRaise,
    turnSeat: room.turnSeat,
    smallBlind: room.smallBlind,
    bigBlind: room.bigBlind,
    buyIn: room.buyIn,
    maxBuyIn: room.maxBuyIn,
    handNumber: room.handNumber,
    dealer: room.dealer,
    sbSeat: room.sbSeat,
    bbSeat: room.bbSeat,
    players: room.seats.map((p) => {
      const item = publicPlayer(p, viewerId, room.phase);
      item.isHost = p.id === room.hostId;
      item.stats = room.stats[p.id] || { handsPlayed: 0, handsWon: 0, vpipHands: 0, vpipCount: 0, totalProfit: 0 };
      return item;
    }),
    log: room.log.slice(-12),
    chat: room.chat.slice(-50),
    showdownResult: room.showdownResult
  };
}

function broadcast(room) {
  for (const player of room.seats) send(player.ws, stateFor(room, player.id));
  for (const [viewerId, ws] of room.spectators) send(ws, stateFor(room, viewerId));
}

function log(room, text) {
  room.log.push(text);
  if (room.log.length > 80) room.log.splice(0, room.log.length - 80);
}

function makeDeck() {
  const deck = [];
  for (const suit of suits) for (const rank of ranks) deck.push(rank + suit);
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function nextActiveSeat(room, fromSeat, includeAllIn = false) {
  if (!room.seats.length) return null;
  for (let step = 1; step <= room.seats.length; step += 1) {
    const idx = (fromSeat + step) % room.seats.length;
    const p = room.seats[idx];
    if (!p.folded && p.chips > 0 && (includeAllIn || !p.allIn)) return idx;
  }
  return null;
}

function livePlayers(room) {
  return room.seats.filter((p) => !p.folded);
}

function playablePlayers(room) {
  return room.seats.filter((p) => !p.folded && !p.allIn && p.chips > 0);
}

function postBlind(room, seat, amount, label) {
  const p = room.seats[seat];
  const paid = Math.min(p.chips, amount);
  p.chips -= paid;
  p.bet += paid;
  p.committed += paid;
  room.pot += paid;
  if (p.chips === 0) p.allIn = true;
  log(room, `${p.name} 下${label} ${paid}`);
}

function startHand(room) {
  const active = room.seats.filter((p) => p.chips > 0);
  if (active.length < 2) {
    room.phase = "lobby";
    log(room, "至少需要两位有筹码的玩家才能开局。");
    return;
  }
  room.phase = "preflop";
  room.handNumber += 1;
  room.showdownResult = null;
  room.deck = makeDeck();
  room.board = [];
  room.pot = 0;
  room.currentBet = room.bigBlind;
  room.minRaise = room.bigBlind;
  room.bettingReopened = true;
  room.reopenBet = room.bigBlind * 2;
  room.dealer = nextOccupied(room, room.dealer);
  room.seats.forEach((p, idx) => {
    p.seat = idx;
    p.cards = p.chips > 0 ? [room.deck.pop(), room.deck.pop()] : [];
    p.bet = 0;
    p.committed = 0;
    p.folded = p.chips <= 0;
    p.allIn = false;
    p.acted = false;
  });
  // Track hands played before blinds, so short stacks all-in from blinds still count.
  room.seats.forEach((p) => {
    if (p.cards.length) {
      if (!room.stats[p.id]) room.stats[p.id] = { handsPlayed: 0, handsWon: 0, vpipHands: 0, vpipCount: 0, totalProfit: 0 };
      room.stats[p.id].handsPlayed += 1;
      room.stats[p.id].vpipHands += 1;
    }
  });
  const sb = room.seats.length === 2 ? room.dealer : nextActiveSeat(room, room.dealer, true);
  const bb = nextActiveSeat(room, sb, true);
  room.sbSeat = sb;
  room.bbSeat = bb;
  postBlind(room, sb, room.smallBlind, "小盲");
  postBlind(room, bb, room.bigBlind, "大盲");
  room.turnSeat = nextActiveSeat(room, bb);
  if (room.turnSeat === null) settleAllInOrAdvance(room);
  log(room, `第 ${room.handNumber} 手牌开始，庄位是 ${room.seats[room.dealer].name}`);
}

function nextOccupied(room, fromSeat) {
  for (let step = 1; step <= room.seats.length; step += 1) {
    const idx = (fromSeat + step + room.seats.length) % room.seats.length;
    if (room.seats[idx]?.chips > 0) return idx;
  }
  return 0;
}

function canEndBetting(room) {
  const live = livePlayers(room);
  if (live.length <= 1) return true;
  const contenders = room.seats.filter((p) => !p.folded && !p.allIn);
  if (contenders.length === 0) return true;
  return contenders.every((p) => p.acted && p.bet === room.currentBet);
}

function moveTurn(room) {
  if (livePlayers(room).length <= 1) return finishByFold(room);
  if (canEndBetting(room)) return advanceStreet(room);
  room.turnSeat = nextActiveSeat(room, room.turnSeat);
  if (room.turnSeat === null) advanceStreet(room);
}

function resetBets(room) {
  room.seats.forEach((p) => {
    p.bet = 0;
    p.acted = false;
  });
  room.currentBet = 0;
  room.minRaise = room.bigBlind;
  room.bettingReopened = true;
  room.reopenBet = room.bigBlind;
}

function advanceStreet(room) {
  if (livePlayers(room).length <= 1) return finishByFold(room);
  const playable = playablePlayers(room);
  // If only 0 or 1 player can still act and others are all-in, no more action needed → run it out
  if (playable.length <= 1 && livePlayers(room).length > 1) return settleAllInOrAdvance(room);
  resetBets(room);
  if (room.phase === "preflop") {
    room.board.push(room.deck.pop(), room.deck.pop(), room.deck.pop());
    room.phase = "flop";
    log(room, "翻牌圈。");
  } else if (room.phase === "flop") {
    room.board.push(room.deck.pop());
    room.phase = "turn";
    log(room, "转牌圈。");
  } else if (room.phase === "turn") {
    room.board.push(room.deck.pop());
    room.phase = "river";
    log(room, "河牌圈。");
  } else {
    return showdown(room);
  }
  room.turnSeat = nextActiveSeat(room, room.dealer);
  if (room.turnSeat === null) settleAllInOrAdvance(room);
}

function settleAllInOrAdvance(room) {
  while (room.board.length < 5 && livePlayers(room).length > 1) room.board.push(room.deck.pop());
  showdown(room);
}

function finishByFold(room) {
  const winner = livePlayers(room)[0];
  if (winner) {
    winner.chips += room.pot;
    if (room.stats[winner.id]) {
      room.stats[winner.id].handsWon += 1;
      room.stats[winner.id].totalProfit += room.pot;
    }
    // Deduct each player's committed chips from their totalProfit
    room.seats.forEach((p) => {
      if (p.committed > 0 && room.stats[p.id]) {
        room.stats[p.id].totalProfit -= p.committed;
      }
    });
    log(room, `${winner.name} 赢得底池 ${room.pot}`);
  }
  room.phase = "showdown";
  room.turnSeat = null;
  room.showdownResult = winner ? {
    winners: [winner.id],
    winnerNames: [winner.name],
    winLabel: "所有人弃牌",
    pot: room.pot,
    players: room.seats.map((p) => ({
      id: p.id,
      name: p.name,
      scoreLabel: p.folded ? "已弃牌" : "未摊牌",
      cards: p.cards,
      folded: p.folded
    }))
  } : null;
}

function showdown(room) {
  room.phase = "showdown";
  room.turnSeat = null;
  const contenders = livePlayers(room);
  const scored = contenders.map((p) => ({ player: p, score: evaluate([...p.cards, ...room.board]) }));
  if (!scored.length) {
    room.showdownResult = null;
    return;
  }
  const { payouts, pots } = distributePots(room, scored);
  for (const payout of payouts) {
    payout.player.chips += payout.amount;
    if (room.stats[payout.player.id]) room.stats[payout.player.id].totalProfit += payout.amount;
  }
  // Deduct each player's committed chips from their totalProfit
  room.seats.forEach((p) => {
    if (p.committed > 0 && room.stats[p.id]) {
      room.stats[p.id].totalProfit -= p.committed;
    }
  });
  const best = scored.slice().sort((a, b) => compareScore(b.score, a.score))[0].score;
  const winnerIds = [...new Set(payouts.map((payout) => payout.player.id))];
  const winners = winnerIds.map((winnerId) => room.seats.find((p) => p.id === winnerId)?.name).filter(Boolean);
  const payoutById = new Map(payouts.map((payout) => [payout.player.id, payout.amount]));
  // Track wins
  winnerIds.forEach((id) => {
    if (room.stats[id]) room.stats[id].handsWon += 1;
  });
  // Build showdown result for display
  room.showdownResult = {
    winners: winnerIds,
    winnerNames: winners,
    winLabel: best.label,
    pot: room.pot,
    payouts: payouts.map((payout) => ({
      id: payout.player.id,
      name: payout.player.name,
      amount: payout.amount
    })),
    pots,
    players: scored.map((entry) => ({
      id: entry.player.id,
      name: entry.player.name,
      scoreLabel: entry.score.label,
      payout: payoutById.get(entry.player.id) || 0,
      cards: entry.player.cards,
      folded: entry.player.folded
    }))
  };
  if (pots.length === 1) {
    log(room, `${winners.join("、")} 以${pots[0].winLabel}摊牌，本手结算 ${room.pot}`);
  } else {
    log(room, `${pots.length} 个底池完成摊牌结算，本手结算 ${room.pot}`);
  }
}

function distributePots(room, scored) {
  const scoreById = new Map(scored.map((entry) => [entry.player.id, entry.score]));
  const levels = [...new Set(room.seats.map((p) => p.committed || 0).filter(Boolean))].sort((a, b) => a - b);
  const payouts = new Map();
  const pots = [];
  let previous = 0;
  for (const level of levels) {
    const contributors = room.seats.filter((p) => (p.committed || 0) >= level);
    const amount = (level - previous) * contributors.length;
    const eligible = contributors.filter((p) => !p.folded && scoreById.has(p.id));
    if (amount > 0 && eligible.length) {
      const ranked = eligible
        .map((player) => ({ player, score: scoreById.get(player.id) }))
        .sort((a, b) => compareScore(b.score, a.score));
      const best = ranked[0].score;
      const winners = oddChipOrder(room, ranked.filter((entry) => compareScore(entry.score, best) === 0));
      const share = Math.floor(amount / winners.length);
      const remainder = amount % winners.length;
      const winnerPayouts = [];
      winners.forEach((entry, idx) => {
        const payoutAmount = share + (idx === 0 ? remainder : 0);
        payouts.set(entry.player, (payouts.get(entry.player) || 0) + payoutAmount);
        winnerPayouts.push({ id: entry.player.id, name: entry.player.name, amount: payoutAmount });
      });
      const isMainPot = pots.length === 0;
      pots.push({
        type: isMainPot ? "main" : "side",
        amount,
        winLabel: best.label,
        winners: winnerPayouts
      });
      log(room, `${winners.map((entry) => entry.player.name).join("、")} 赢得${isMainPot ? "主池" : "边池"} ${amount}`);
    }
    previous = level;
  }
  return {
    payouts: [...payouts.entries()].map(([player, amount]) => ({ player, amount })),
    pots
  };
}

function action(room, playerId, kind, amount = 0) {
  const seat = room.seats.findIndex((p) => p.id === playerId);
  const p = room.seats[seat];
  if (!p) return "你还没有入座。";
  if (room.phase === "lobby") return "牌局还没有开始。";
  if (room.phase === "showdown") return "本手牌已结束。";
  if (seat !== room.turnSeat) return "还没轮到你行动。";
  if (p.folded || p.allIn) return "当前无法行动。";
  const toCall = Math.max(0, room.currentBet - p.bet);
  if (kind === "fold") {
    p.folded = true;
    p.acted = true;
    log(room, `${p.name} 弃牌`);
  } else if (kind === "check") {
    if (toCall > 0) return `需要先跟注 ${toCall}`;
    p.acted = true;
    log(room, `${p.name} 过牌`);
  } else if (kind === "call") {
    const paid = Math.min(p.chips, toCall);
    p.chips -= paid;
    p.bet += paid;
    p.committed += paid;
    room.pot += paid;
    p.acted = true;
    if (p.chips === 0) p.allIn = true;
    // Track VPIP: voluntarily put money in pot (call when > 0 to call means putting money in)
    if (toCall > 0 && room.stats[p.id]) room.stats[p.id].vpipCount += 1;
    log(room, p.allIn && paid < toCall ? `${p.name} All in ${paid}` : `${p.name} 跟注 ${paid}`);
  } else if (kind === "raise" || kind === "allIn") {
    const raiseTo = kind === "allIn" ? p.bet + p.chips : Math.max(0, Number(amount) || 0);
    const minTo = room.currentBet + room.minRaise;
    if (p.acted && toCall > 0 && raiseTo > room.currentBet && !room.bettingReopened) return "短码 All in 未重新开放加注，只能跟注或弃牌。";
    if (raiseTo < minTo && raiseTo < p.bet + p.chips) return `最小加注到 ${minTo}`;
    if (raiseTo <= room.currentBet && raiseTo < p.bet + p.chips) return "加注额需要高于当前注额。";
    const pay = Math.min(p.chips, raiseTo - p.bet);
    const oldBet = p.bet;
    const oldCurrentBet = room.currentBet;
    p.chips -= pay;
    p.bet += pay;
    p.committed += pay;
    room.pot += pay;
    p.acted = true;
    if (p.chips === 0) p.allIn = true;
    if (p.bet > room.currentBet) {
      const fullBetStart = room.reopenBet - room.minRaise;
      room.currentBet = p.bet;
      const fullRaise = p.bet - oldCurrentBet >= room.minRaise || p.bet >= room.reopenBet;
      if (fullRaise) {
        room.bettingReopened = true;
        room.minRaise = Math.max(room.minRaise, p.bet - fullBetStart);
        room.reopenBet = p.bet + room.minRaise;
        room.seats.forEach((other) => {
          if (other.id !== p.id && !other.folded && !other.allIn) other.acted = false;
        });
      } else {
        room.bettingReopened = false;
      }
    }
    // Track VPIP
    if (room.stats[p.id]) room.stats[p.id].vpipCount += 1;
    log(room, p.allIn ? `${p.name} All in 到 ${p.bet}` : `${p.name} 从 ${oldBet} 加注到 ${p.bet}`);
  }
  moveTurn(room);
  return null;
}

function oddChipOrder(room, winners) {
  return winners.slice().sort((a, b) => {
    const aDistance = ((a.player.seat - room.dealer + room.seats.length) % room.seats.length) || room.seats.length;
    const bDistance = ((b.player.seat - room.dealer + room.seats.length) % room.seats.length) || room.seats.length;
    return aDistance - bDistance;
  });
}

function evaluate(cards) {
  const combos = [];
  for (let a = 0; a < cards.length - 4; a += 1)
    for (let b = a + 1; b < cards.length - 3; b += 1)
      for (let c = b + 1; c < cards.length - 2; c += 1)
        for (let d = c + 1; d < cards.length - 1; d += 1)
          for (let e = d + 1; e < cards.length; e += 1) combos.push([cards[a], cards[b], cards[c], cards[d], cards[e]]);
  return combos.map(scoreFive).sort(compareScore).at(-1);
}

function scoreFive(cards) {
  const values = cards.map((c) => rankValue[c[0]]).sort((a, b) => b - a);
  const flush = cards.every((c) => c[1] === cards[0][1]);
  const unique = [...new Set(values)].sort((a, b) => b - a);
  const wheel = unique.includes(14) && unique.includes(5) && unique.includes(4) && unique.includes(3) && unique.includes(2);
  let straightHigh = 0;
  if (wheel) straightHigh = 5;
  else {
    for (let i = 0; i <= unique.length - 5; i += 1) {
      if (unique[i] - unique[i + 4] === 4) {
        straightHigh = unique[i];
        break;
      }
    }
  }
  const counts = new Map();
  values.forEach((v) => counts.set(v, (counts.get(v) || 0) + 1));
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  if (flush && straightHigh) return score(8, [straightHigh], "同花顺");
  if (groups[0][1] === 4) return score(7, [groups[0][0], ...groups.filter((g) => g[0] !== groups[0][0]).map((g) => g[0])], "四条");
  if (groups[0][1] === 3 && groups[1]?.[1] === 2) return score(6, [groups[0][0], groups[1][0]], "葫芦");
  if (flush) return score(5, values, "同花");
  if (straightHigh) return score(4, [straightHigh], "顺子");
  if (groups[0][1] === 3) return score(3, [groups[0][0], ...groups.slice(1).map((g) => g[0])], "三条");
  if (groups[0][1] === 2 && groups[1]?.[1] === 2) return score(2, [groups[0][0], groups[1][0], ...groups.slice(2).map((g) => g[0])], "两对");
  if (groups[0][1] === 2) return score(1, [groups[0][0], ...groups.slice(1).map((g) => g[0])], "一对");
  return score(0, values, "高牌");
}

function score(category, kickers, label) {
  return { category, kickers, label };
}

function compareScore(a, b) {
  if (a.category !== b.category) return a.category - b.category;
  for (let i = 0; i < Math.max(a.kickers.length, b.kickers.length); i += 1) {
    const diff = (a.kickers[i] || 0) - (b.kickers[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

function joinRoom(room, ws, payload) {
  const playerId = String(payload.playerId || id(10));
  const name = String(payload.name || "玩家").trim().slice(0, 16) || "玩家";
  let player = room.seats.find((p) => p.id === playerId);
  if (!player && room.seats.length < 6 && room.phase === "lobby") {
    player = { id: playerId, name, chips: room.buyIn, cards: [], bet: 0, committed: 0, folded: false, allIn: false, acted: false, ws, seat: room.seats.length };
    room.seats.push(player);
    if (!room.hostId) room.hostId = playerId;
    log(room, `${name} 入座`);
  } else if (player) {
    player.ws = ws;
    player.name = name;
    log(room, `${name} 回到牌桌`);
  } else {
    room.spectators.set(playerId, ws);
    send(ws, { type: "toast", message: "牌局进行中或座位已满，已进入观战。" });
  }
  ws.roomId = room.id;
  ws.playerId = playerId;
  send(ws, { type: "hello", playerId, roomId: room.id });
  broadcast(room);
}

function onMessage(ws, payload) {
  const room = roomById(ws.roomId || payload.roomId);
  if (payload.type === "join") return joinRoom(room, ws, payload);
  const player = room.seats.find((p) => p.id === ws.playerId);
  if (payload.type === "start") {
    if (!player || player.id !== room.hostId) return send(ws, { type: "toast", message: "只有房主可以开局。" });
    if (room.phase !== "lobby" && room.phase !== "showdown") return send(ws, { type: "toast", message: "当前手牌还没结束。" });
    startHand(room);
    return broadcast(room);
  }
  if (payload.type === "settings") {
    if (!player || player.id !== room.hostId) return send(ws, { type: "toast", message: "只有房主可以修改牌桌设置。" });
    if (room.phase !== "lobby" && room.phase !== "showdown") return send(ws, { type: "toast", message: "手牌进行中不能修改设置。" });
    const smallBlind = clampInt(payload.smallBlind, 1, 10000);
    const bigBlind = clampInt(payload.bigBlind, smallBlind * 2, 20000);
    const buyIn = clampInt(payload.buyIn, bigBlind * 20, 200000);
    const maxBuyIn = clampInt(payload.maxBuyIn, buyIn, 500000);
    room.smallBlind = smallBlind;
    room.bigBlind = bigBlind;
    room.buyIn = buyIn;
    room.maxBuyIn = maxBuyIn;
    room.minRaise = bigBlind;
    log(room, `房主设置牌桌：${smallBlind}/${bigBlind}，默认买入 ${buyIn}`);
    return broadcast(room);
  }
  if (payload.type === "buyIn") {
    if (!player) return send(ws, { type: "toast", message: "先入座再买入。" });
    if (room.phase !== "lobby" && room.phase !== "showdown") return send(ws, { type: "toast", message: "手牌进行中不能买入。" });
    const target = clampInt(payload.amount, room.bigBlind, room.maxBuyIn);
    const added = Math.max(0, target - player.chips);
    if (!added) return send(ws, { type: "toast", message: "当前筹码已经不少于目标买入。" });
    player.chips += added;
    log(room, `${player.name} 买入补码 ${added}，当前筹码 ${player.chips}`);
    return broadcast(room);
  }
  if (payload.type === "leaveToLobby") {
    if (!player || player.id !== room.hostId) return send(ws, { type: "toast", message: "只有房主可以重置牌桌。" });
    room.phase = "lobby";
    room.board = [];
    room.pot = 0;
    room.turnSeat = null;
    room.showdownResult = null;
    room.seats.forEach((p) => {
      p.cards = [];
      p.bet = 0;
      p.committed = 0;
      p.folded = false;
      p.allIn = false;
      if (p.chips <= 0) p.chips = room.buyIn;
    });
    log(room, "牌桌已回到大厅。");
    return broadcast(room);
  }
  if (payload.type === "resetRoom") {
    if (!player || player.id !== room.hostId) return send(ws, { type: "toast", message: "只有房主可以重置牌桌。" });
    room.phase = "lobby";
    room.board = [];
    room.pot = 0;
    room.turnSeat = null;
    room.showdownResult = null;
    room.seats.forEach((p) => {
      p.cards = [];
      p.bet = 0;
      p.committed = 0;
      p.folded = false;
      p.allIn = false;
      p.chips = room.buyIn;
    });
    log(room, "牌桌已重置，所有人重新买入。");
    return broadcast(room);
  }
  if (payload.type === "leave") {
    if (!player) return;
    const seatIdx = room.seats.findIndex((p) => p.id === ws.playerId);
    if (seatIdx >= 0) {
      log(room, `${player.name} 离开了牌桌`);
      room.seats.splice(seatIdx, 1);
      // Reassign seats
      room.seats.forEach((p, i) => { p.seat = i; });
      // If host left, assign new host
      if (player.id === room.hostId) {
        room.hostId = room.seats.length > 0 ? room.seats[0].id : null;
        if (room.hostId) log(room, `${room.seats[0].name} 成为新房主`);
      }
    }
    room.spectators.delete(ws.playerId);
    return broadcast(room);
  }
  if (payload.type === "chat") {
    const text = String(payload.text || "").trim().slice(0, 200);
    if (!text) return;
    const senderName = player ? player.name : "旁观者";
    const chatMsg = { name: senderName, text, time: Date.now() };
    room.chat.push(chatMsg);
    if (room.chat.length > 200) room.chat.splice(0, room.chat.length - 200);
    // Broadcast chat message to all
    for (const p of room.seats) send(p.ws, { type: "chat", ...chatMsg });
    for (const [, spectatorWs] of room.spectators) send(spectatorWs, { type: "chat", ...chatMsg });
    return;
  }
  if (payload.type === "action") {
    const err = action(room, ws.playerId, payload.action, payload.amount);
    if (err) send(ws, { type: "toast", message: err });
    return broadcast(room);
  }
}

function clampInt(value, min, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/api/room") return json(res, 200, { roomId: id(6) });
  if (url.pathname === "/api/rooms") {
    const list = [];
    for (const [, r] of rooms) {
      list.push({
        id: r.id,
        playerCount: r.seats.length,
        phase: r.phase,
        smallBlind: r.smallBlind,
        bigBlind: r.bigBlind,
        buyIn: r.buyIn,
        handNumber: r.handNumber
      });
    }
    return json(res, 200, list);
  }
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(publicDir, requested));
  if (!filePath.startsWith(publicDir)) return json(res, 403, { error: "forbidden" });
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    const type = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" }[ext] || "application/octet-stream";
    res.writeHead(200, { "content-type": `${type}; charset=utf-8` });
    res.end(data);
  });
});

server.on("upgrade", (req, socket) => {
  if (req.headers.upgrade?.toLowerCase() !== "websocket") return socket.destroy();
  const key = req.headers["sec-websocket-key"];
  const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    ""
  ].join("\r\n"));
  readFrames(socket, (payload) => onMessage(socket, payload));
  socket.on("close", () => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    const player = room.seats.find((p) => p.id === socket.playerId);
    if (player && player.ws === socket) {
      player.ws = null;
      log(room, `${player.name} 暂时离线`);
    }
    room.spectators.delete(socket.playerId);
    broadcast(room);
  });
});

server.listen(port, host, () => {
  console.log(`Texas Hold'em table running at http://${host}:${port}`);
});
