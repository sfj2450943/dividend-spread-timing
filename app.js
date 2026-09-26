/* 中证红利 40日收益差择时看板 — 逻辑层 */

(function () {
  'use strict';

  var DATA = null;
  var state = {
    mode: 'wind',          // 'wind' | 'proxy'
    engine: 'simple',      // 'simple'（单买卖线）| 'combo'（年线分档）
    buyTh: -1.0,
    sellTh: 5.0,
    maWin: 242,            // 收益差年线窗口（交易日）
    showMA: true,          // 主图是否叠加年线
    ma: null,              // 年线序列
    cross: null,           // { up:[], down:[] }
    crossMap: null,        // 索引 → 'up' | 'down'
    raw: null,             // 当前回测结果
    bh: null,              // 买入持有基准
    ref: null,             // 组合版下的「简单版 −1%/+5%」对照
    combo: {               // 组合版参数（年线分档）
      buy: -1.0,           // 两档共用买入线
      sellUp: 8.0,         // 年线 > 0 时的卖出线
      sellDown: 5.0,       // 年线 < 0 时的卖出线
      capLo: 0.5,          // 年线 < 0 时的仓位上限
      addUp: 0.0,          // 年线 > 0 时的加仓幅度（0 = 不加杠杆）
      finRate: 6.0,        // 融资年化成本 %（仅 addUp > 0 生效）
      costBps: 0           // 单边交易成本 bps
    },
    charts: {}
  };

  var COLOR = {
    spread: '#185FA5',
    buy: '#185FA5',
    sell: '#D85A30',
    zero: '#B4B2A9',
    strat: '#185FA5',
    hold: '#888780',
    band: 'rgba(55,138,221,0.10)',
    ma: '#E24B4A',         // 年线（文中红色虚线，此处实线）
    crossUp: '#E24B4A',    // 上穿 0 轴（红涨）
    crossDown: '#1D9E75'   // 下穿 0 轴（绿跌）
  };

  function $(id) { return document.getElementById(id); }

  function fmtPct(v, dp) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return (v >= 0 ? '+' : '') + v.toFixed(dp === undefined ? 2 : dp) + '%';
  }

  function fmtDate(s) {
    if (!s || s.length !== 8) return s || '—';
    return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  }

  /* ───────── 通用统计工具 ───────── */

  function mean(a) {
    if (!a.length) return 0;
    return a.reduce(function (x, y) { return x + y; }, 0) / a.length;
  }

  function stdev(a) {
    if (a.length < 2) return 0;
    var m = mean(a);
    return Math.sqrt(a.reduce(function (s, v) { return s + (v - m) * (v - m); }, 0) / (a.length - 1));
  }

  function maxDrawdown(nav) {
    var peak = nav[0], mdd = 0;
    for (var i = 0; i < nav.length; i++) {
      if (nav[i] > peak) peak = nav[i];
      var dd = nav[i] / peak - 1;
      if (dd < mdd) mdd = dd;
    }
    return mdd;
  }

  // 由净值序列 + 仓位序列导出波动率 / Sharpe / 平均仓位 / 换手倍数
  // start：统计起点下标（组合版从「年线首个可用日」起算，跳过空仓等待期）
  function weightStats(nav, w, start) {
    var s0 = start || 0;
    var rets = [], turn = 0, i;
    for (i = s0 + 1; i < nav.length; i++) rets.push(nav[i] / nav[i - 1] - 1);
    for (i = s0 + 1; i < w.length; i++) turn += Math.abs(w[i] - w[i - 1]);
    var sd = stdev(rets);
    return {
      vol: sd * Math.sqrt(252) * 100,
      sharpe: sd > 0 ? mean(rets) / sd * Math.sqrt(252) : null,
      avgWeight: mean(w.slice(s0)) * 100,
      turnover: turn / 2
    };
  }

  // 年线首个可用下标（组合版的策略启动日）
  function firstMaIdx(ma) {
    for (var i = 0; i < ma.length; i++) { if (isValid(ma[i])) return i; }
    return 0;
  }

  /* ───────── 回测（与 scripts/fetch_data.py 保持同一逻辑） ───────── */

  function spreadArray() {
    return state.mode === 'wind' ? DATA.series.spread_wind : DATA.series.spread_proxy;
  }

  /*
   * 成交口径（与 scripts/fetch_data.py 保持一致）
   *   信号 = spread[i-1]；pos[i] 决定第 i 日是否吃 r_i = divNav[i]/divNav[i-1]。
   *   => 建仓触发的 pos[entry]=1 是「第 entry-1 日收盘」成交，持有至「第 out-1 日收盘」卖出。
   *   => 单笔实现收益 = divNav[out-1] / divNav[entry-1] - 1
   *   故 trades 里 buy/sell 存的是「成交日」在 dates 中的下标（= 信号日下标）。
   */
  function backtest(divNav, spread, buyTh, sellTh) {
    var n = divNav.length;
    var pos = new Array(n);
    var i, sig;
    pos[0] = 0;

    var trades = [];
    var entry = null;

    for (i = 1; i < n; i++) {
      sig = spread[i - 1];
      var cur = pos[i - 1];
      if (sig === null || sig === undefined) {
        pos[i] = cur;
      } else if (cur === 0 && sig < buyTh) {
        pos[i] = 1;
        entry = i;
      } else if (cur === 1 && sig > sellTh) {
        pos[i] = 0;
        if (entry !== null) {
          trades.push({ buy: entry - 1, sell: i - 1, days: i - entry, ret: (divNav[i - 1] / divNav[entry - 1] - 1) * 100 });
          entry = null;
        }
      } else {
        pos[i] = cur;
      }
    }
    if (entry !== null) {
      trades.push({ buy: entry - 1, sell: n - 1, days: n - entry, ret: (divNav[n - 1] / divNav[entry - 1] - 1) * 100, open: true });
    }

    var nav = new Array(n);
    nav[0] = 1;
    for (i = 1; i < n; i++) {
      var r = divNav[i] / divNav[i - 1] - 1;
      nav[i] = nav[i - 1] * (1 + (pos[i] ? r : 0));
    }

    var years = (n - 1) / 252;
    var closed = trades.filter(function (t) { return !t.open; });
    var wins = closed.filter(function (t) { return t.ret > 0; });
    var losses = closed.filter(function (t) { return t.ret <= 0; });
    var avgWin = wins.length ? wins.reduce(function (a, t) { return a + t.ret; }, 0) / wins.length : 0;
    var avgLoss = losses.length ? Math.abs(losses.reduce(function (a, t) { return a + t.ret; }, 0) / losses.length) : 0;

    var peak = nav[0], mdd = 0;
    for (i = 0; i < n; i++) {
      if (nav[i] > peak) peak = nav[i];
      var dd = nav[i] / peak - 1;
      if (dd < mdd) mdd = dd;
    }

    var holdDays = pos.reduce(function (a, p) { return a + p; }, 0);
    var ws = weightStats(nav, pos);

    return {
      nav: nav,
      pos: pos,
      w: pos.slice(),
      trades: trades,
      stats: {
        totalReturn: (nav[n - 1] - 1) * 100,
        annualReturn: (Math.pow(nav[n - 1], 1 / years) - 1) * 100,
        maxDrawdown: mdd * 100,
        tradeCount: closed.length,
        winRate: closed.length ? wins.length / closed.length * 100 : 0,
        plRatio: avgLoss > 0 ? avgWin / avgLoss : null,
        avgWin: avgWin,
        avgLoss: -avgLoss,
        avgHoldDays: closed.length ? Math.round(closed.reduce(function (a, t) { return a + t.days; }, 0) / closed.length) : 0,
        holdRatio: holdDays / n * 100,
        vol: ws.vol,
        sharpe: ws.sharpe,
        avgWeight: ws.avgWeight,
        turnover: ws.turnover,
        openPosition: !!(trades.length && trades[trades.length - 1].open)
      }
    };
  }

  // 买入持有基准；start 指定统计起点（组合版与策略同区间，便于直接比较）
  function buyAndHold(divNav, start) {
    var n = divNav.length;
    var s0 = start || 0;
    var nav = new Array(n);
    var base = divNav[0];
    for (var i = 0; i < n; i++) nav[i] = divNav[i] / base;
    var years = (n - 1 - s0) / 252;
    var mult = years > 0 ? nav[n - 1] / nav[s0] : 1;
    return {
      nav: nav,
      startIdx: s0,
      totalReturn: (mult - 1) * 100,
      annualReturn: (Math.pow(mult, 1 / years) - 1) * 100,
      maxDrawdown: maxDrawdown(nav.slice(s0)) * 100
    };
  }

  function percentile(values, x) {
    var clean = values.filter(function (v) { return v !== null && v !== undefined; });
    if (!clean.length || x === null || x === undefined) return null;
    var c = clean.filter(function (v) { return v <= x; }).length;
    return c / clean.length * 100;
  }

  /* ───────── 收益差年线（242 日均线）与 0 轴穿越 ───────── */

  function isValid(v) { return v !== null && v !== undefined && !isNaN(v); }

  // 前缀和实现：窗口内必须恰好 w 个有效值才输出，遇缺口则该点为空
  function maArray(arr, w) {
    var n = arr.length;
    var out = new Array(n);
    var psum = new Array(n + 1);
    var pcnt = new Array(n + 1);
    psum[0] = 0; pcnt[0] = 0;
    for (var i = 0; i < n; i++) {
      var v = arr[i];
      var ok = isValid(v);
      psum[i + 1] = psum[i] + (ok ? v : 0);
      pcnt[i + 1] = pcnt[i] + (ok ? 1 : 0);
      if (i + 1 >= w && (pcnt[i + 1] - pcnt[i + 1 - w]) === w) {
        out[i] = (psum[i + 1] - psum[i + 1 - w]) / w;
      } else {
        out[i] = null;
      }
    }
    return out;
  }

  // 年线穿越 0 轴：上穿 = 前值 < 0 且现值 ≥ 0；下穿反之
  function buildCross(ma) {
    var up = [], down = [], map = {};
    for (var i = 1; i < ma.length; i++) {
      var a = ma[i - 1], b = ma[i];
      if (!isValid(a) || !isValid(b)) continue;
      if (a < 0 && b >= 0) { up.push([i, b]); map[i] = 'up'; }
      else if (a >= 0 && b < 0) { down.push([i, b]); map[i] = 'down'; }
    }
    return { up: up, down: down, map: map };
  }

  // 最近一次穿越（从末尾往回找）
  function lastCross(ma) {
    for (var i = ma.length - 1; i > 0; i--) {
      var a = ma[i - 1], b = ma[i];
      if (!isValid(a) || !isValid(b)) continue;
      if (a < 0 && b >= 0) return { i: i, dir: 'up' };
      if (a >= 0 && b < 0) return { i: i, dir: 'down' };
    }
    return null;
  }

  /* ───────── 组合版：年线分档（分层卖出线 + 弱市封顶 + 强市加仓） ───────── */

  /*
   * 规则（与 combo_report.py / combo_default_check.py 的 build_combo 一致）
   *   年线 ≥ 0（强市）：卖出线 = sellUp（默认 +8%）　仓位上限 100%　可加仓 addUp
   *   年线 < 0（弱市）：卖出线 = sellDown（默认 +5%）　仓位上限 capLo（默认 50%）
   *   目标仓位 w = min(tgt, 上限) × 加仓系数，tgt ∈ {0,1} 由分层买卖线给出的持有状态
   *   口径同简单版：第 i 日仓位由第 i-1 日的收益差与年线决定（0 日延迟）
   */
  function comboWeights(spread, ma, cfg) {
    var n = spread.length;
    var w = new Array(n), tgt = new Array(n);
    w[0] = 0; tgt[0] = 0;
    for (var i = 1; i < n; i++) {
      var sig = spread[i - 1];
      var m = isValid(ma[i - 1]) ? ma[i - 1] : null;
      if (!isValid(sig) || m === null) {
        tgt[i] = tgt[i - 1];
      } else {
        var up = m >= 0;
        var sell = up ? cfg.sellUp : cfg.sellDown;
        if (tgt[i - 1] === 0 && sig < cfg.buy) tgt[i] = 1;
        else if (tgt[i - 1] === 1 && sig > sell) tgt[i] = 0;
        else tgt[i] = tgt[i - 1];
      }
      var strong = (m !== null && m >= 0);
      var cap = strong ? 1 : cfg.capLo;
      var add = strong ? (1 + cfg.addUp) : 1;
      w[i] = Math.min(tgt[i], cap) * add;
    }
    return { w: w, tgt: tgt };
  }

  // 每日净收益因子：w 倍标的收益 − 调仓单边成本 − 融资利息（仅对超出 100% 的部分计息）
  function comboDailyFactor(divNav, w, cfg, i) {
    var r = divNav[i] / divNav[i - 1] - 1;
    var cost = Math.abs(w[i] - w[i - 1]) * cfg.costBps / 10000;
    var fin = w[i] > 1 ? (w[i] - 1) * cfg.finRate / 100 / 252 : 0;
    return 1 + w[i] * r - cost - fin;
  }

  function comboNav(divNav, w, cfg) {
    var n = divNav.length;
    var nav = new Array(n);
    nav[0] = 1;
    for (var i = 1; i < n; i++) nav[i] = nav[i - 1] * comboDailyFactor(divNav, w, cfg, i);
    return nav;
  }

  /*
   * 按「仓位档位」切段：每段内仓位恒定。
   * 段收益 = Π(段内每日净收益因子) − 1，各段连乘恒等于累计收益（自洽校验口径）。
   */
  function comboSegments(divNav, w, cfg) {
    var n = w.length;
    if (n < 2) return [];
    var bounds = [], s = 1;
    for (var i = 2; i <= n; i++) {
      if (i === n || Math.abs(w[i] - w[s]) > 1e-12) { bounds.push([s, i - 1]); s = i; }
    }
    var out = [];
    for (var k = 0; k < bounds.length; k++) {
      var from = bounds[k][0], to = bounds[k][1];
      var acc = 1;
      for (var j = from; j <= to; j++) acc *= comboDailyFactor(divNav, w, cfg, j);
      var wv = w[from];
      var adj = k > 0 && bounds[k - 1][1] === from - 1;   // 前一段是否紧邻（决定「建仓 / 加仓」）
      var prevW = adj ? w[bounds[k - 1][0]] : 0;
      out.push({
        buy: from - 1,
        sell: to,
        days: to - from + 1,
        ret: (acc - 1) * 100,
        w: wv,
        prevW: prevW,
        act: wv === 0 ? '清仓' : (prevW === 0 ? '建仓' : (wv > prevW + 1e-12 ? '加仓' : '减仓')),
        open: (to === n - 1) && wv > 0,
        flat: wv === 0
      });
    }
    return out;
  }

  function comboBacktest(divNav, spread, ma, cfg, start) {
    var n = divNav.length;
    var s0 = start || 0;
    var w = comboWeights(spread, ma, cfg).w;
    var nav = comboNav(divNav, w, cfg);
    var segs = comboSegments(divNav, w, cfg);
    var traded = segs.filter(function (x) { return !x.flat; });
    var closed = traded.filter(function (x) { return !x.open; });
    var wins = closed.filter(function (x) { return x.ret > 0; });
    var losses = closed.filter(function (x) { return x.ret <= 0; });
    var avgWin = wins.length ? mean(wins.map(function (x) { return x.ret; })) : 0;
    var avgLoss = losses.length ? Math.abs(mean(losses.map(function (x) { return x.ret; }))) : 0;
    var holdDays = w.reduce(function (a, x) { return a + (x > 0 ? 1 : 0); }, 0);
    var years = (n - 1 - s0) / 252;
    var ws = weightStats(nav, w, s0);

    return {
      nav: nav,
      w: w,
      startIdx: s0,
      pos: w.map(function (x) { return x > 0 ? 1 : 0; }),
      trades: traded,
      stats: {
        totalReturn: (nav[n - 1] - 1) * 100,
        annualReturn: (Math.pow(nav[n - 1], 1 / years) - 1) * 100,
        maxDrawdown: maxDrawdown(nav.slice(s0)) * 100,
        tradeCount: traded.length,
        winRate: closed.length ? wins.length / closed.length * 100 : 0,
        plRatio: avgLoss > 0 ? avgWin / avgLoss : null,
        avgWin: avgWin,
        avgLoss: -avgLoss,
        avgHoldDays: traded.length ? Math.round(mean(traded.map(function (x) { return x.days; }))) : 0,
        holdRatio: holdDays / (n - s0) * 100,
        vol: ws.vol,
        sharpe: ws.sharpe,
        avgWeight: ws.avgWeight,
        turnover: ws.turnover,
        openPosition: !!(traded.length && traded[traded.length - 1].open)
      }
    };
  }

  // 用最新一根收盘信号推出的「下一交易日应持有的仓位」（0 日延迟：当日收盘执行）
  function comboNextTarget() {
    var cfg = state.combo;
    var sp = spreadArray();
    var last = sp.length - 1;
    var sig = sp[last];
    var m = isValid(state.ma[last]) ? state.ma[last] : null;
    var strong = (m !== null && m >= 0);
    var cap = strong ? 1 : cfg.capLo;
    var add = strong ? (1 + cfg.addUp) : 1;
    var holding = state.raw.w[last] > 0;
    var hold;
    if (!isValid(sig) || m === null) hold = holding;
    else if (!holding) hold = sig < cfg.buy;
    else hold = !(sig > (strong ? cfg.sellUp : cfg.sellDown));
    return { tgt: hold ? Math.min(1, cap) * add : 0, hold: hold, strong: strong, ma: m, sig: sig };
  }

  /* ───────── 渲染 ───────── */

  // 当前应执行的动作（两套引擎共用）
  function signalOf() {
    var sp = spreadArray();
    var sig = sp[sp.length - 1];

    if (state.engine === 'combo') {
      var cfg = state.combo;
      var nt = comboNextTarget();
      var curW = state.raw.w[sp.length - 1];
      var pctT = (nt.tgt * 100).toFixed(0);
      var side = nt.ma === null ? '年线数据不足' : (nt.strong ? '年线在 0 轴上方' : '年线在 0 轴下方');
      var sellTh = nt.strong ? cfg.sellUp : cfg.sellDown;
      if (curW === 0) {
        if (nt.hold && nt.tgt > 0) {
          return { text: '买入 ' + pctT + '%', sub: side + ' → 建仓 ' + pctT + '%', dir: 'buy' };
        }
        return {
          text: '空仓等待',
          sub: nt.strong ? '等收益差跌破 ' + fmtPct(cfg.buy, 1)
                         : '弱市上限 ' + (cfg.capLo * 100).toFixed(0) + '%，暂不参与',
          dir: 'idle'
        };
      }
      if (!nt.hold) {
        return { text: '清仓', sub: '涨破' + (nt.strong ? '强市' : '弱市') + '卖出线 ' + fmtPct(sellTh, 1), dir: 'sell' };
      }
      if (Math.abs(nt.tgt - curW) > 1e-9) {
        var up2 = nt.tgt > curW;
        return {
          text: (up2 ? '加仓至 ' : '减仓至 ') + pctT + '%',
          sub: '年线档位切换 → 目标 ' + pctT + '%',
          dir: up2 ? 'buy' : 'sell'
        };
      }
      return {
        text: '继续持有',
        sub: '仓位 ' + (curW * 100).toFixed(0) + '%，未达卖出线 ' + fmtPct(sellTh, 1),
        dir: 'hold'
      };
    }

    if (sig < state.buyTh) return { text: '买入', sub: '跌破买入线 ' + fmtPct(state.buyTh, 1), dir: 'buy' };
    if (sig > state.sellTh) return { text: '卖出', sub: '涨破卖出线 ' + fmtPct(state.sellTh, 1), dir: 'sell' };
    if (state.raw.stats.openPosition) return { text: '持有', sub: '未达卖出线', dir: 'hold' };
    return { text: '空仓', sub: '等待跌破买入线', dir: 'idle' };
  }

  function renderKPI() {
    var s = spreadArray();
    var dates = DATA.series.dates;
    var last = s.length - 1;
    var cur = s[last];
    var r = state.raw;
    var st = r.stats;

    $('kpiDate').textContent = fmtDate(dates[last]);
    $('kpiSpread').textContent = fmtPct(cur, 2);
    var lowTh = state.engine === 'combo' ? state.combo.buy : state.buyTh;
    var highTh = state.engine === 'combo'
      ? (state.combo.sellDown)
      : state.sellTh;
    $('kpiSpread').style.color = cur < lowTh ? COLOR.buy : (cur > highTh ? COLOR.sell : 'inherit');

    var sg = signalOf();
    $('kpiSignal').textContent = sg.text;
    $('kpiSignal').style.color = sg.dir === 'buy' ? COLOR.buy : (sg.dir === 'sell' ? COLOR.sell : 'inherit');
    $('kpiSignalSub').textContent = sg.sub;

    var heldTxt, heldSub;
    var segs = state.raw.trades || [];   // 注意：stats 里没有 trades，持仓段在 raw.trades
    if (state.engine === 'combo') {
      $('kpiHeldLb').textContent = '当前仓位';
      var curW = r.w[dates.length - 1];
      heldTxt = (curW * 100).toFixed(0) + '%';
      if (curW > 0 && segs.length) {
        heldSub = '最近一次调仓 ' + fmtDate(dates[segs[segs.length - 1].buy]);
      } else if (curW > 0) {
        heldSub = '持仓中';
      } else {
        var nt2 = comboNextTarget();
        heldSub = (nt2.hold && nt2.tgt > 0)
          ? '最新信号建议建仓 ' + (nt2.tgt * 100).toFixed(0) + '%'
          : '空仓中 · 等收益差跌破 ' + fmtPct(state.combo.buy, 1);
      }
    } else {
      $('kpiHeldLb').textContent = '已持有';
      if (st.openPosition && segs.length) {
        var t = segs[segs.length - 1];
        heldTxt = (dates.length - 1 - t.buy) + ' 天';
        heldSub = '自 ' + fmtDate(dates[t.buy]) + ' 起持有';
      } else {
        heldTxt = '0 天';
        heldSub = '空仓中';
      }
    }
    $('kpiHeld').textContent = heldTxt;
    $('kpiHeldSub').textContent = heldSub;

    var p3 = percentile(s.slice(Math.max(0, last - 750)), cur);
    $('kpiPct').textContent = p3 === null ? '—' : p3.toFixed(0) + '%';
    $('kpiPctSub').textContent = '近 3 年 · 全历史 ' +
      (percentile(s, cur) === null ? '—' : percentile(s, cur).toFixed(0) + '%');

    // 趋势卡：收益差年线（242 日）
    var ma = state.ma || [];
    var mv = ma[last];
    $('kpiMA').textContent = fmtPct(mv, 2);
    $('kpiMA').style.color = !isValid(mv) ? 'inherit' : (mv >= 0 ? COLOR.crossUp : COLOR.crossDown);
    var lc = lastCross(ma);
    var side = !isValid(mv) ? '数据不足' : (mv >= 0 ? '0 轴上方 · 红利偏强' : '0 轴下方 · 红利偏弱');
    $('kpiMAsub').textContent = side +
      (lc ? ' · 最近' + (lc.dir === 'up' ? '上穿 ' : '下穿 ') + fmtDate(dates[lc.i]) : '');
  }

  function renderStats() {
    var st = state.raw.stats;
    var bh = state.bh;
    var isCombo = state.engine === 'combo';

    $('perfTitle').textContent = isCombo ? '组合方案表现' : '策略表现';
    $('perfSub').textContent = isCombo
      ? '自 ' + fmtDate(DATA.series.dates[state.raw.startIdx]) + ' 起（年线可用日）· 含调仓成本' +
        (state.combo.addUp > 0 ? '与 ' + state.combo.finRate + '% 融资成本' : '（不含融资）')
      : '全区间 · 按上述参数实时重算';
    $('statTradesLb').textContent = isCombo ? '调仓段数' : '交易次数';

    if (isCombo) {
      $('bhTitle').textContent = '买入持有基准 · 同区间';
      $('bhSub').textContent = '自 ' + fmtDate(DATA.series.dates[state.bh.startIdx]) + ' 起始终满仓中证红利全收益指数';
    } else {
      $('bhTitle').textContent = '买入持有基准';
      $('bhSub').textContent = '始终满仓中证红利全收益指数';
    }

    $('statTotal').textContent = fmtPct(st.totalReturn, 1);
    $('statAnnual').textContent = fmtPct(st.annualReturn, 2);
    $('statExcess').textContent = fmtPct(st.annualReturn - bh.annualReturn, 2);
    $('statMDD').textContent = st.maxDrawdown.toFixed(2) + '%';
    $('statTrades').textContent = st.tradeCount + ' 次';
    $('statWin').textContent = st.winRate.toFixed(1) + '%';
    $('statPL').textContent = st.plRatio === null ? '—' : st.plRatio.toFixed(2);
    $('statHold').textContent = st.holdRatio.toFixed(0) + '%';
    $('statAvgHold').textContent = st.avgHoldDays ? st.avgHoldDays + ' 天' : '—';
    $('statVol').textContent = st.vol === null ? '—' : st.vol.toFixed(2) + '%';
    $('statSharpe').textContent = st.sharpe === null ? '—' : st.sharpe.toFixed(2);
    $('statAvgW').textContent = st.avgWeight.toFixed(1) + '%';
    $('statTurn').textContent = st.turnover.toFixed(2);
    $('statMDD').style.color = st.maxDrawdown < -30 ? COLOR.sell : 'inherit';
    $('statAvgW').style.color = st.avgWeight > 100.5 ? COLOR.sell : 'inherit';

    $('bhTotal').textContent = fmtPct(bh.totalReturn, 1);
    $('bhAnnual').textContent = fmtPct(bh.annualReturn, 2);
    $('bhMDD').textContent = bh.maxDrawdown.toFixed(2) + '%';
  }

  function renderTrades() {
    var dates = DATA.series.dates;
    var isCombo = state.engine === 'combo';
    var rows = state.raw.trades.slice().reverse();

    $('tradeHead').innerHTML = isCombo
      ? '<th>调仓日</th><th>操作</th><th class="num">目标仓位</th><th>结束日</th>' +
        '<th class="num">段内交易日</th><th class="num">区间收益</th>'
      : '<th>买入日</th><th>卖出日</th><th class="num">持有交易日</th>' +
        '<th class="num">区间收益</th><th>状态</th>';

    var html = rows.map(function (t) {
      var cls = t.ret > 0 ? 'win' : 'lose';
      if (isCombo) {
        return '<tr>' +
          '<td>' + fmtDate(dates[t.buy]) + '</td>' +
          '<td>' + t.act + '</td>' +
          '<td class="num">' + (t.w * 100).toFixed(0) + '%</td>' +
          '<td>' + (t.open ? '持有中' : fmtDate(dates[t.sell])) + '</td>' +
          '<td class="num">' + t.days + '</td>' +
          '<td class="num ' + cls + '">' + fmtPct(t.ret, 2) + '</td>' +
          '</tr>';
      }
      var tag = t.open ? '<span class="tag">持有中</span>' : '';
      return '<tr>' +
        '<td>' + fmtDate(dates[t.buy]) + '</td>' +
        '<td>' + (t.open ? '—' : fmtDate(dates[t.sell])) + '</td>' +
        '<td class="num">' + t.days + '</td>' +
        '<td class="num ' + cls + '">' + fmtPct(t.ret, 2) + '</td>' +
        '<td>' + tag + '</td>' +
        '</tr>';
    }).join('');

    $('tradeBody').innerHTML = html ||
      '<tr><td colspan="' + (isCombo ? 6 : 5) + '" class="empty">当前参数下无成交</td></tr>';
    $('tradeCount').textContent = state.raw.trades.length;
    $('tradeTitle').textContent = isCombo ? '调仓明细' : '交易明细';
    $('tradeNote').innerHTML = isCombo
      ? '调仓日 = 信号触发日、按该日收盘价成交（0 日延迟）· 目标仓位 = 调仓后应持有的仓位比例 · ' +
        '「段内交易日」为该仓位维持的交易日数 · 段收益按逐日净值因子累乘（含调仓成本' +
        (state.combo.addUp > 0 ? '与融资利息' : '') + '），各段收益连乘 = 累计收益'
      : '买卖日 = 信号触发日、按该日收盘价成交（0 日延迟）· 区间收益 = 卖出日收盘净值 ÷ 买入日收盘净值 − 1 · ' +
        '逐笔区间收益连乘 = 上述「累计收益」（持有中一笔按最新净值折算，仅四舍五入误差 &lt;0.1pct）';
  }

  function holdingRanges() {
    var s = spreadArray();
    var pos = state.raw.pos;
    var out = [];
    var start = null;
    for (var i = 0; i < pos.length; i++) {
      if (pos[i] === 1 && start === null) start = i;
      if (pos[i] === 0 && start !== null) { out.push([start, i]); start = null; }
    }
    if (start !== null) out.push([start, pos.length - 1]);
    return out.map(function (r) { return [{ xAxis: r[0] }, { xAxis: r[1] }]; });
  }

  function renderMainChart() {
    var dates = DATA.series.dates;
    var s = spreadArray();
    var labels = dates.map(fmtDate);
    var isCombo = state.engine === 'combo';

    // 阈值：组合版有两条卖出线（强市放宽 / 弱市收紧）
    var buyLine = isCombo ? state.combo.buy : state.buyTh;
    var sellLines = isCombo
      ? [{ v: state.combo.sellUp, t: '卖出线·强市 ' + fmtPct(state.combo.sellUp, 1), c: COLOR.sell },
         { v: state.combo.sellDown, t: '卖出线·弱市 ' + fmtPct(state.combo.sellDown, 1), c: '#E89B7E' }]
      : [{ v: state.sellTh, t: '卖出线 ' + fmtPct(state.sellTh, 1), c: COLOR.sell }];
    var sellLo = Math.min.apply(null, sellLines.map(function (x) { return x.v; }));

    var buyPts = [], sellPts = [];
    for (var i = 0; i < s.length; i++) {
      if (s[i] === null) continue;
      if (s[i] < buyLine) buyPts.push([i, s[i]]);
      if (s[i] > sellLo) sellPts.push([i, s[i]]);
    }

    // 标签左右分置：卖出线靠右、中轴与买入线靠左，避免数值接近时文字重叠
    var mkData = sellLines.map(function (x, idx) {
      return {
        yAxis: x.v,
        lineStyle: { color: x.c, type: 'dashed', width: 1 },
        label: {
          formatter: x.t, color: x.c,
          position: (sellLines.length > 1 && idx > 0) ? 'insideEndBottom' : 'insideEndTop'
        }
      };
    });
    mkData.push({
      yAxis: 0, lineStyle: { color: COLOR.zero, type: 'dashed', width: 1 },
      label: { formatter: '中轴 0%', color: '#888780', position: 'insideStartTop' }
    });
    mkData.push({
      yAxis: buyLine, lineStyle: { color: COLOR.buy, type: 'dashed', width: 1 },
      label: { formatter: '买入线 ' + fmtPct(buyLine, 1), color: COLOR.buy, position: 'insideStartBottom' }
    });

    var startPct = s.length > 1200 ? Math.round((1 - 750 / s.length) * 100) : 0;

    var opt = {
      animation: false,
      grid: { left: 56, right: 24, top: 48, bottom: 64 },
      legend: {
        top: 0, left: 0, itemWidth: 14, itemHeight: 8, itemGap: 16,
        textStyle: { color: '#5F5E5A', fontSize: 12 },
        data: ['收益差', '收益差年线 242日', '上穿 0 轴', '下穿 0 轴']
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: COLOR.zero } },
        formatter: function (ps) {
          var main = null, k;
          for (k = 0; k < ps.length; k++) { if (ps[k].seriesName === '收益差') { main = ps[k]; break; } }
          if (!main) return '';
          var di = main.dataIndex;
          var v = (main.value !== null && typeof main.value === 'object') ? main.value[1] : main.value;
          var row = '<div class="tt-date">' + main.axisValue + '</div>';
          row += '<div class="tt-row"><span class="tt-dot" style="background:' + COLOR.spread + '"></span>' +
            '收益差 <b>' + fmtPct(v, 2) + '</b></div>';
          if (state.showMA && isValid(state.ma[di])) {
            row += '<div class="tt-row"><span class="tt-dot" style="background:' + COLOR.ma + '"></span>' +
              '年线 242日 <b>' + fmtPct(state.ma[di], 2) + '</b></div>';
          }
          if (state.showMA && state.crossMap && state.crossMap[di]) {
            var dir = state.crossMap[di];
            row += '<div class="tt-row"><span class="tt-dot" style="background:' +
              (dir === 'up' ? COLOR.crossUp : COLOR.crossDown) + '"></span>年线 <b>' +
              (dir === 'up' ? '上穿' : '下穿') + ' 0 轴</b></div>';
          }
          if (state.raw && state.raw.w) {
            var wv = state.raw.w[di];
            row += '<div class="tt-row"><span class="tt-dot" style="background:' +
              (wv > 0 ? COLOR.strat : COLOR.zero) + '"></span>' +
              '仓位 <b>' + (state.engine === 'combo'
                ? (wv * 100).toFixed(0) + '%'
                : (wv > 0 ? '持有' : '空仓')) + '</b></div>';
          }
          return row;
        }
      },
      xAxis: {
        type: 'category',
        data: labels,
        boundaryGap: false,
        axisLine: { lineStyle: { color: '#D3D1C7' } },
        axisLabel: { color: '#888780', fontSize: 11, hideOverlap: true },
        axisTick: { show: false }
      },
      yAxis: {
        type: 'value',
        name: '收益差 %',
        nameTextStyle: { color: '#888780', fontSize: 11, padding: [0, 0, 0, -28] },
        axisLine: { show: false },
        axisLabel: { color: '#888780', fontSize: 11, formatter: '{value}' },
        splitLine: { lineStyle: { color: '#EFEEE9' } }
      },
      dataZoom: [
        { type: 'inside', start: startPct, end: 100 },
        { type: 'slider', start: startPct, end: 100, height: 22, bottom: 14,
          borderColor: '#D3D1C7', fillerColor: 'rgba(55,138,221,0.10)',
          handleStyle: { color: '#B4B2A9' }, textStyle: { color: '#888780', fontSize: 11 } }
      ],
      series: [
        {
          name: '收益差',
          type: 'line',
          data: s,
          showSymbol: false,
          lineStyle: { width: 1.4, color: COLOR.spread },
          connectNulls: false,
          markArea: {
            silent: true,
            itemStyle: { color: COLOR.band },
            data: holdingRanges()
          },
          markLine: {
            silent: true,
            symbol: 'none',
            label: { position: 'insideEndTop', fontSize: 11 },
            data: mkData
          }
        },
        {
          name: '买入',
          type: 'scatter',
          data: buyPts,
          symbolSize: 5,
          itemStyle: { color: COLOR.buy, opacity: 0.85 },
          tooltip: { show: false }
        },
        {
          name: '卖出',
          type: 'scatter',
          data: sellPts,
          symbolSize: 5,
          itemStyle: { color: COLOR.sell, opacity: 0.85 },
          tooltip: { show: false }
        },
        {
          name: '收益差年线 242日',
          type: 'line',
          data: state.showMA ? state.ma : [],
          showSymbol: false,
          lineStyle: { width: 1.6, color: COLOR.ma },
          connectNulls: false,
          z: 3,
          tooltip: { show: false }
        },
        {
          name: '上穿 0 轴',
          type: 'scatter',
          data: state.showMA && state.cross ? state.cross.up : [],
          symbol: 'triangle',
          symbolSize: 9,
          itemStyle: { color: COLOR.crossUp },
          z: 4,
          tooltip: { show: false }
        },
        {
          name: '下穿 0 轴',
          type: 'scatter',
          data: state.showMA && state.cross ? state.cross.down : [],
          symbol: 'triangle',
          symbolRotate: 180,
          symbolSize: 9,
          itemStyle: { color: COLOR.crossDown },
          z: 4,
          tooltip: { show: false }
        }
      ]
    };

    state.charts.main.setOption(opt, true);
  }

  function renderNavChart() {
    var dates = DATA.series.dates;
    var labels = dates.map(fmtDate);
    var isCombo = state.engine === 'combo';
    var stratName = isCombo ? '组合方案（当前参数）' : '择时策略';
    var nav = state.raw.nav;
    var bh = state.bh.nav;

    var series = [
      { name: stratName, type: 'line', data: nav, showSymbol: false,
        lineStyle: { width: 1.7, color: COLOR.strat } }
    ];
    var legendData = [stratName];
    if (isCombo && state.ref) {
      series.push({ name: '简单版 −1%/+5%', type: 'line', data: state.ref.nav, showSymbol: false,
        lineStyle: { width: 1.2, color: '#9DBBD8', type: 'dashed' } });
      legendData.push('简单版 −1%/+5%');
    }
    series.push({ name: '买入持有', type: 'line', data: bh, showSymbol: false,
      lineStyle: { width: 1.4, color: COLOR.hold } });
    legendData.push('买入持有');

    var opt = {
      animation: false,
      grid: { left: 60, right: 24, top: 34, bottom: 48 },
      legend: {
        top: 0, right: 0, itemWidth: 14, itemHeight: 2,
        textStyle: { color: '#5F5E5A', fontSize: 12 },
        data: legendData
      },
      tooltip: {
        trigger: 'axis',
        formatter: function (ps) {
          var row = '<div class="tt-date">' + ps[0].axisValue + '</div>';
          ps.forEach(function (p) {
            row += '<div class="tt-row"><span class="tt-dot" style="background:' + p.color + '"></span>' +
              p.seriesName + ' <b>' + p.value.toFixed(2) + '</b></div>';
          });
          var rg = state.raw.w ? state.raw.w[ps[0].dataIndex] : null;
          if (rg !== null && rg !== undefined) {
            row += '<div class="tt-row"><span class="tt-dot" style="background:' + COLOR.zero + '"></span>' +
              '仓位 <b>' + (isCombo ? (rg * 100).toFixed(0) + '%' : (rg > 0 ? '持有' : '空仓')) + '</b></div>';
          }
          return row;
        }
      },
      xAxis: {
        type: 'category', data: labels, boundaryGap: false,
        axisLine: { lineStyle: { color: '#D3D1C7' } },
        axisLabel: { color: '#888780', fontSize: 11, hideOverlap: true },
        axisTick: { show: false }
      },
      yAxis: {
        type: 'log',
        name: '净值（起始 1.0）', nameTextStyle: { color: '#888780', fontSize: 11 },
        axisLine: { show: false },
        axisLabel: { color: '#888780', fontSize: 11, formatter: function (v) { return v.toFixed(1); } },
        splitLine: { lineStyle: { color: '#EFEEE9' } }
      },
      dataZoom: [{ type: 'inside' }],
      series: series
    };

    state.charts.nav.setOption(opt, true);
  }

  // 组合版专属：今日操作建议
  function renderAdvice() {
    var card = $('adviceCard');
    if (state.engine !== 'combo') { card.style.display = 'none'; return; }
    card.style.display = '';

    var dates = DATA.series.dates;
    var last = dates.length - 1;
    var cfg = state.combo;
    var nt = comboNextTarget();
    var sg = signalOf();
    var curW = state.raw.w[last];
    var pctT = (nt.tgt * 100).toFixed(0);
    var sellNow = nt.strong ? cfg.sellUp : cfg.sellDown;

    $('adviceDate').textContent = '数据截至 ' + fmtDate(dates[last]) +
      ' 收盘 · 按该日收盘信号决策、该日收盘价成交（0 日延迟）';
    $('adviceBadge').textContent = '组合版 · 年线分档' + (cfg.addUp > 0 ? ' · 含杠杆' : ' · 无杠杆');

    $('adviceAct').textContent = sg.text;
    $('adviceAct').style.color = sg.dir === 'buy' ? COLOR.buy : (sg.dir === 'sell' ? COLOR.sell : 'inherit');

    var why;
    if (curW === 0 && nt.hold && nt.tgt > 0) {
      why = '收益差 ' + fmtPct(nt.sig, 2) + ' 已跌破买入线 ' + fmtPct(cfg.buy, 1) + '。' +
        (nt.strong
          ? '年线在 0 轴上方，红利相对走强，可建满仓' + (cfg.addUp > 0 ? '并按设定加仓至 ' + pctT + '%' : '') + '。'
          : '但年线在 0 轴下方，红利相对走弱，只建 ' + pctT + '% 的防守仓位。');
    } else if (curW === 0) {
      why = '收益差 ' + fmtPct(nt.sig, 2) + ' 尚未跌破买入线 ' + fmtPct(cfg.buy, 1) + '，继续等待。' +
        '当前年线 ' + (nt.ma === null ? '数据不足' : (nt.strong ? '在 0 轴上方' : '在 0 轴下方') + '（' + fmtPct(nt.ma, 2) + '）。');
    } else if (!nt.hold) {
      why = '收益差 ' + fmtPct(nt.sig, 2) + ' 已涨破' + (nt.strong ? '强市' : '弱市') + '卖出线 ' +
        fmtPct(sellNow, 1) + '，按规则清仓离场。';
    } else if (Math.abs(nt.tgt - curW) > 1e-9) {
      why = '年线由' + (nt.strong ? '负转正' : '正转负') + '，档位切换：卖出线改为 ' + fmtPct(sellNow, 1) +
        '，仓位' + (nt.strong ? '可提到 100%' + (cfg.addUp > 0 ? '（加仓后 ' + pctT + '%）' : '') : '上限降到 ' + pctT + '%') + '。';
    } else {
      why = '收益差 ' + fmtPct(nt.sig, 2) + ' 位于买入线 ' + fmtPct(cfg.buy, 1) + ' 与' +
        (nt.strong ? '强市' : '弱市') + '卖出线 ' + fmtPct(sellNow, 1) + ' 之间，维持当前仓位不动。';
    }
    $('adviceWhy').textContent = why;

    $('advSig').textContent = fmtPct(nt.sig, 2);
    $('advSig').style.color = nt.sig < cfg.buy ? COLOR.buy : (nt.sig > sellNow ? COLOR.sell : 'inherit');
    $('advMA').textContent = nt.ma === null ? '—' : fmtPct(nt.ma, 2);
    $('advMA').style.color = nt.ma === null ? 'inherit' : (nt.strong ? COLOR.crossUp : COLOR.crossDown);
    $('advState').textContent = nt.ma === null ? '数据不足' : (nt.strong ? '0 轴上方' : '0 轴下方');
    $('advState').style.color = nt.ma === null ? 'inherit' : (nt.strong ? COLOR.crossUp : COLOR.crossDown);
    $('advCur').textContent = (curW * 100).toFixed(0) + '%';
    var tgtShow = (sg.dir === 'sell') ? '0%' : pctT + '%';
    $('advTgt').textContent = tgtShow;
    $('advTgt').style.color = sg.dir === 'sell' ? COLOR.sell : (sg.dir === 'buy' ? COLOR.buy : 'inherit');

    var msgs = [];
    if (cfg.addUp > 0) {
      var strongPct = ((1 + cfg.addUp) * 100).toFixed(0);
      msgs.push('<b>已启用杠杆</b>：年线 0 轴上方时仓位 ' + strongPct + '%，超出 100% 的部分按年化 ' +
        cfg.finRate + '% 计息。该配置历史最大回撤约 −32%，快速下跌时存在强制平仓风险。');
    }
    if (nt.ma !== null && !nt.strong) {
      msgs.push('<b>年线在 0 轴下方</b>：历史统计中，年线 &lt; 0 期间红利的前瞻收益明显低于年线 &gt; 0 期间，' +
        '本档位只做防守 —— 半仓 + 收紧卖出线，不做加仓。');
    }
    var warn = $('adviceWarn');
    if (msgs.length) { warn.innerHTML = msgs.join('<br>'); warn.style.display = ''; }
    else { warn.style.display = 'none'; }
  }

  function recompute() {
    var divNav = DATA.series.div_nav;
    var sp = spreadArray();
    // 口径标签随 mode 同步（原先只在 applyData 里赋一次，切换口径时不刷新）
    $('mktCode').textContent = state.mode === 'wind'
      ? DATA.meta.market_wind.code
      : DATA.meta.market_proxy.code;
    state.ma = maArray(sp, state.maWin);
    state.cross = buildCross(state.ma);
    state.crossMap = state.cross.map;

    // 组合版从「年线首个可用日」起算：此前 242 天无信号、策略处于空仓等待期
    var s0 = state.engine === 'combo' ? firstMaIdx(state.ma) : 0;
    state.bh = buyAndHold(divNav, s0);

    if (state.engine === 'combo') {
      state.raw = comboBacktest(divNav, sp, state.ma, state.combo, s0);
      state.ref = backtest(divNav, sp, -1.0, 5.0);
    } else {
      state.raw = backtest(divNav, sp, state.buyTh, state.sellTh);
      state.ref = null;
    }

    renderKPI();
    renderStats();
    renderTrades();
    renderAdvice();
    renderMainChart();
    renderNavChart();
  }

  /* ───────── 交互 ───────── */

  /* ───────── 交互 ───────── */

  var COMBO_PRESETS = {
    P0: { buy: -1, sellUp: 5, sellDown: 5, capLo: 1.0, addUp: 0 },
    P2: { buy: -1, sellUp: 8, sellDown: 5, capLo: 0.5, addUp: 0 },
    P3: { buy: -1, sellUp: 8, sellDown: 5, capLo: 0.3, addUp: 0 },
    P4: { buy: -1, sellUp: 8, sellDown: 5, capLo: 0.5, addUp: 0.3 },
    P5: { buy: -1, sellUp: 8, sellDown: 5, capLo: 0.5, addUp: 0.5 }
  };

  function syncComboUI() {
    var cfg = state.combo;
    $('cBuy').value = cfg.buy;
    $('cBuyVal').textContent = fmtPct(cfg.buy, 1);
    $('cSellUp').value = cfg.sellUp;
    $('cSellUpVal').textContent = fmtPct(cfg.sellUp, 1);
    $('cSellDown').value = cfg.sellDown;
    $('cSellDownVal').textContent = fmtPct(cfg.sellDown, 1);
    $('cCapLo').value = Math.round(cfg.capLo * 100);
    $('cCapLoVal').textContent = (cfg.capLo * 100).toFixed(0) + '%';
    $('cAddUp').value = Math.round(cfg.addUp * 100);
    $('cAddUpVal').textContent = (cfg.addUp > 0 ? '+' : '') + (cfg.addUp * 100).toFixed(0) + '%';
    $('cFin').value = cfg.finRate;
    $('cFinVal').textContent = cfg.finRate + '%/年';
    $('cCost').value = cfg.costBps;
    $('cCostVal').textContent = cfg.costBps + ' bps';
    $('cFin').disabled = cfg.addUp <= 0;
    $('cFinVal').style.opacity = cfg.addUp <= 0 ? 0.45 : 1;
  }

  function markComboPresetActive() {
    var cfg = state.combo;
    document.querySelectorAll('[data-combo]').forEach(function (el) {
      var p = COMBO_PRESETS[el.getAttribute('data-combo')];
      var on = !!p &&
        Math.abs(p.buy - cfg.buy) < 1e-9 && Math.abs(p.sellUp - cfg.sellUp) < 1e-9 &&
        Math.abs(p.sellDown - cfg.sellDown) < 1e-9 && Math.abs(p.capLo - cfg.capLo) < 1e-9 &&
        Math.abs(p.addUp - cfg.addUp) < 1e-9;
      el.classList.toggle('active', on);
    });
  }

  function setEngine(engine) {
    state.engine = engine;
    var isCombo = engine === 'combo';
    document.querySelectorAll('[data-engine]').forEach(function (x) {
      x.classList.toggle('active', x.getAttribute('data-engine') === engine);
    });
    $('panelSimple').style.display = isCombo ? 'none' : '';
    $('panelCombo').style.display = isCombo ? '' : 'none';
    $('paramSub').textContent = isCombo
      ? '组合版：年线（242日）状态决定卖出线与仓位上限｜T 日收盘观察信号，T 日收盘成交（0 日延迟）'
      : 'T 日收盘观察信号，T 日收盘成交（0 日延迟）；持仓期间吃中证红利全收益指数日收益';
    if (isCombo) markComboPresetActive(); else markPresetActive();
  }

  function bindControls() {
    document.querySelectorAll('[data-mode]').forEach(function (el) {
      el.addEventListener('click', function () {
        state.mode = el.getAttribute('data-mode');
        document.querySelectorAll('[data-mode]').forEach(function (x) {
          x.classList.toggle('active', x === el);
        });
        recompute();
      });
    });

    document.querySelectorAll('[data-engine]').forEach(function (el) {
      el.addEventListener('click', function () {
        setEngine(el.getAttribute('data-engine'));
        recompute();
      });
    });

    var maBtn = $('maToggle');
    if (maBtn) {
      maBtn.classList.toggle('active', state.showMA);
      maBtn.addEventListener('click', function () {
        state.showMA = !state.showMA;
        maBtn.classList.toggle('active', state.showMA);
        renderMainChart();
      });
    }

    $('buySlider').addEventListener('input', function () {
      var v = parseFloat(this.value);
      if (v >= state.sellTh) v = state.sellTh - 0.5;
      state.buyTh = v;
      $('buyVal').textContent = fmtPct(v, 1);
      markPresetActive();
      recompute();
    });

    $('sellSlider').addEventListener('input', function () {
      var v = parseFloat(this.value);
      if (v <= state.buyTh) v = state.buyTh + 0.5;
      state.sellTh = v;
      $('sellVal').textContent = fmtPct(v, 1);
      markPresetActive();
      recompute();
    });

    document.querySelectorAll('[data-preset]').forEach(function (el) {
      el.addEventListener('click', function () {
        var b = parseFloat(el.getAttribute('data-buy'));
        var s = parseFloat(el.getAttribute('data-sell'));
        state.buyTh = b;
        state.sellTh = s;
        $('buySlider').value = b;
        $('sellSlider').value = s;
        $('buyVal').textContent = fmtPct(b, 1);
        $('sellVal').textContent = fmtPct(s, 1);
        document.querySelectorAll('[data-preset]').forEach(function (x) {
          x.classList.toggle('active', x === el);
        });
        recompute();
      });
    });

    /* ── 组合版滑块 ── */
    var comboRanges = [
      ['cBuy', 'cBuyVal', function (v) { state.combo.buy = v; }],
      ['cSellUp', 'cSellUpVal', function (v) { state.combo.sellUp = v; }],
      ['cSellDown', 'cSellDownVal', function (v) { state.combo.sellDown = v; }],
      ['cCapLo', 'cCapLoVal', function (v) { state.combo.capLo = v / 100; }],
      ['cAddUp', 'cAddUpVal', function (v) { state.combo.addUp = v / 100; }],
      ['cFin', 'cFinVal', function (v) { state.combo.finRate = v; }],
      ['cCost', 'cCostVal', function (v) { state.combo.costBps = v; }]
    ];
    comboRanges.forEach(function (r) {
      $(r[0]).addEventListener('input', function () {
        r[2](parseFloat(this.value));
        syncComboUI();
        markComboPresetActive();
        recompute();
      });
    });

    /* ── 组合版预设 ── */
    document.querySelectorAll('[data-combo]').forEach(function (el) {
      el.addEventListener('click', function () {
        var p = COMBO_PRESETS[el.getAttribute('data-combo')];
        if (!p) return;
        state.combo.buy = p.buy;
        state.combo.sellUp = p.sellUp;
        state.combo.sellDown = p.sellDown;
        state.combo.capLo = p.capLo;
        state.combo.addUp = p.addUp;
        syncComboUI();
        markComboPresetActive();
        recompute();
      });
    });

    window.addEventListener('resize', function () {
      state.charts.main.resize();
      state.charts.nav.resize();
    });
  }

  function markPresetActive() {
    document.querySelectorAll('[data-preset]').forEach(function (el) {
      var b = parseFloat(el.getAttribute('data-buy'));
      var s = parseFloat(el.getAttribute('data-sell'));
      el.classList.toggle('active', Math.abs(b - state.buyTh) < 1e-9 && Math.abs(s - state.sellTh) < 1e-9);
    });
  }

  /* ───────── 启动 ───────── */

  function applyData(d) {
    DATA = d;
    $('updated').textContent = d.updated.replace('T', ' ').slice(0, 16);
    $('span').textContent = fmtDate(d.meta.start) + ' → ' + fmtDate(d.meta.end) +
      ' · ' + d.meta.trading_days + ' 个交易日 · 窗口 ' + d.meta.window + ' 日';
    $('divCode').textContent = d.meta.dividend.code;

    var dp = d.presets.filter(function (p) { return p.name === d.default_preset; })[0] || d.presets[0];
    state.buyTh = dp.buy;
    state.sellTh = dp.sell;
    $('buySlider').value = dp.buy;
    $('sellSlider').value = dp.sell;
    $('buyVal').textContent = fmtPct(dp.buy, 1);
    $('sellVal').textContent = fmtPct(dp.sell, 1);
    markPresetActive();

    syncComboUI();
    setEngine('combo');   // 默认进入组合版（年线分档规则）

    state.charts.main = echarts.init($('mainChart'));
    state.charts.nav = echarts.init($('navChart'));
    bindControls();
    recompute();
    $('loading').style.display = 'none';
  }

  function showError(msg, hint) {
    $('loading').innerHTML = '<div class="err">数据加载失败：' + msg +
      '<br><span class="err-sub">' + hint + '</span></div>';
  }

  function boot() {
    // ① 优先用内联数据（data/data.js）：双击 index.html 也能直接出图
    if (window.__SPREAD_DATA__) {
      try {
        applyData(window.__SPREAD_DATA__);
      } catch (e) {
        showError(e.message || String(e), '内联数据（data/data.js）解析异常，请重跑 <code>python scripts/fetch_data.py</code> 重新生成。');
      }
      return;
    }
    // ② 回退：走 HTTP 读取 data/data.json
    fetch('data/data.json?v=' + Date.now())
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(applyData)
      .catch(function (e) {
        showError(e.message || String(e),
          '未找到内联数据 <code>data/data.js</code>，且 <code>fetch(data/data.json)</code> 被浏览器同源策略阻断。' +
          '请任选其一：① 重跑 <code>python scripts/fetch_data.py</code> 生成 data/data.js；' +
          '② 用 HTTP 打开本页（<code>python -m http.server</code>）。');
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
