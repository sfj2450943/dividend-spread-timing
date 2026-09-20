/* 中证红利 40日收益差择时看板 — 逻辑层 */

(function () {
  'use strict';

  var DATA = null;
  var state = {
    mode: 'wind',          // 'wind' | 'proxy'
    buyTh: -1.0,
    sellTh: 5.0,
    maWin: 242,            // 收益差年线窗口（交易日）
    showMA: true,          // 主图是否叠加年线
    ma: null,              // 年线序列
    crossMap: null,        // 索引 → 'up' | 'down'
    raw: null,             // 当前回测结果
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

  /* ───────── 回测（与 scripts/fetch_data.py 保持同一逻辑） ───────── */

  function spreadArray() {
    return state.mode === 'wind' ? DATA.series.spread_wind : DATA.series.spread_proxy;
  }

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
          trades.push({ in: entry, out: i, days: i - entry, ret: (divNav[i] / divNav[entry] - 1) * 100 });
          entry = null;
        }
      } else {
        pos[i] = cur;
      }
    }
    if (entry !== null) {
      trades.push({ in: entry, out: n - 1, days: n - 1 - entry, ret: (divNav[n - 1] / divNav[entry] - 1) * 100, open: true });
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

    return {
      nav: nav,
      pos: pos,
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
        openPosition: !!(trades.length && trades[trades.length - 1].open)
      }
    };
  }

  function buyAndHold(divNav) {
    var n = divNav.length;
    var nav = new Array(n);
    var base = divNav[0];
    for (var i = 0; i < n; i++) nav[i] = divNav[i] / base;
    var peak = nav[0], mdd = 0;
    for (i = 0; i < n; i++) {
      if (nav[i] > peak) peak = nav[i];
      var dd = nav[i] / peak - 1;
      if (dd < mdd) mdd = dd;
    }
    var years = (n - 1) / 252;
    return {
      nav: nav,
      totalReturn: (nav[n - 1] - 1) * 100,
      annualReturn: (Math.pow(nav[n - 1], 1 / years) - 1) * 100,
      maxDrawdown: mdd * 100
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

  /* ───────── 渲染 ───────── */

  function renderKPI() {
    var s = spreadArray();
    var dates = DATA.series.dates;
    var last = s.length - 1;
    var cur = s[last];
    var r = state.raw;
    var st = r.stats;

    $('kpiDate').textContent = fmtDate(dates[last]);
    $('kpiSpread').textContent = fmtPct(cur, 2);
    $('kpiSpread').style.color = cur < state.buyTh ? COLOR.buy : (cur > state.sellTh ? COLOR.sell : 'inherit');

    var sigText, sigSub;
    if (cur < state.buyTh) { sigText = '买入'; sigSub = '跌破买入线 ' + fmtPct(state.buyTh, 1); }
    else if (cur > state.sellTh) { sigText = '卖出'; sigSub = '涨破卖出线 ' + fmtPct(state.sellTh, 1); }
    else if (st.openPosition) { sigText = '持有'; sigSub = '未达卖出线'; }
    else { sigText = '空仓'; sigSub = '等待跌破买入线'; }
    $('kpiSignal').textContent = sigText;
    $('kpiSignal').style.color = sigText === '买入' ? COLOR.buy : (sigText === '卖出' ? COLOR.sell : 'inherit');
    $('kpiSignalSub').textContent = sigSub;

    var heldTxt, heldSub;
    if (st.openPosition) {
      var t = st.trades[st.trades.length - 1];
      heldTxt = (dates.length - 1 - t.in) + ' 天';
      heldSub = '自 ' + fmtDate(dates[t.in]) + ' 起持有';
    } else {
      heldTxt = '0 天';
      heldSub = '空仓中';
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
    $('statTotal').textContent = fmtPct(st.totalReturn, 1);
    $('statAnnual').textContent = fmtPct(st.annualReturn, 2);
    $('statExcess').textContent = fmtPct(st.annualReturn - bh.annualReturn, 2);
    $('statMDD').textContent = st.maxDrawdown.toFixed(2) + '%';
    $('statTrades').textContent = st.tradeCount + ' 次';
    $('statWin').textContent = st.winRate.toFixed(1) + '%';
    $('statPL').textContent = st.plRatio === null ? '—' : st.plRatio.toFixed(2);
    $('statHold').textContent = st.holdRatio.toFixed(0) + '%';
    $('statAvgHold').textContent = st.avgHoldDays ? st.avgHoldDays + ' 天' : '—';

    $('bhTotal').textContent = fmtPct(bh.totalReturn, 1);
    $('bhAnnual').textContent = fmtPct(bh.annualReturn, 2);
    $('bhMDD').textContent = bh.maxDrawdown.toFixed(2) + '%';
  }

  function renderTrades() {
    var dates = DATA.series.dates;
    var rows = state.raw.trades.slice().reverse();
    var html = rows.map(function (t) {
      var cls = t.open ? 'open' : (t.ret > 0 ? 'win' : 'lose');
      var tag = t.open ? '<span class="tag tag-open">持有中</span>' : '';
      return '<tr>' +
        '<td>' + fmtDate(dates[t.in]) + '</td>' +
        '<td>' + (t.open ? '—' : fmtDate(dates[t.out])) + '</td>' +
        '<td class="num">' + t.days + '</td>' +
        '<td class="num ' + cls + '">' + fmtPct(t.ret, 2) + '</td>' +
        '<td>' + tag + '</td>' +
        '</tr>';
    }).join('');
    $('tradeBody').innerHTML = html || '<tr><td colspan="5" class="empty">当前参数下无成交</td></tr>';
    $('tradeCount').textContent = state.raw.trades.length;
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

    var buyPts = [], sellPts = [];
    for (var i = 0; i < s.length; i++) {
      if (s[i] === null) continue;
      if (s[i] < state.buyTh) buyPts.push([i, s[i]]);
      if (s[i] > state.sellTh) sellPts.push([i, s[i]]);
    }

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
          if (state.raw && state.raw.pos) {
            var held = state.raw.pos[di] === 1;
            row += '<div class="tt-row"><span class="tt-dot" style="background:' +
              (held ? COLOR.strat : COLOR.zero) + '"></span>' +
              '仓位 <b>' + (held ? '持有' : '空仓') + '</b></div>';
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
            data: [
              { yAxis: state.sellTh, lineStyle: { color: COLOR.sell, type: 'dashed', width: 1 },
                label: { formatter: '卖出线 ' + fmtPct(state.sellTh, 1), color: COLOR.sell } },
              { yAxis: 0, lineStyle: { color: COLOR.zero, type: 'dashed', width: 1 },
                label: { formatter: '中轴 0%', color: '#888780' } },
              { yAxis: state.buyTh, lineStyle: { color: COLOR.buy, type: 'dashed', width: 1 },
                label: { formatter: '买入线 ' + fmtPct(state.buyTh, 1), color: COLOR.buy, position: 'insideEndBottom' } }
            ]
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
    var nav = state.raw.nav;
    var bh = state.bh.nav;

    var opt = {
      animation: false,
      grid: { left: 60, right: 24, top: 34, bottom: 48 },
      legend: {
        top: 0, right: 0, itemWidth: 14, itemHeight: 2,
        textStyle: { color: '#5F5E5A', fontSize: 12 },
        data: ['择时策略', '买入持有']
      },
      tooltip: {
        trigger: 'axis',
        formatter: function (ps) {
          var row = '<div class="tt-date">' + ps[0].axisValue + '</div>';
          ps.forEach(function (p) {
            row += '<div class="tt-row"><span class="tt-dot" style="background:' + p.color + '"></span>' +
              p.seriesName + ' <b>' + p.value.toFixed(2) + '</b></div>';
          });
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
      series: [
        {
          name: '择时策略', type: 'line', data: nav, showSymbol: false,
          lineStyle: { width: 1.6, color: COLOR.strat }
        },
        {
          name: '买入持有', type: 'line', data: bh, showSymbol: false,
          lineStyle: { width: 1.4, color: COLOR.hold }
        }
      ]
    };

    state.charts.nav.setOption(opt, true);
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
    state.raw = backtest(divNav, sp, state.buyTh, state.sellTh);
    state.bh = buyAndHold(divNav);
    renderKPI();
    renderStats();
    renderTrades();
    renderMainChart();
    renderNavChart();
  }

  /* ───────── 交互 ───────── */

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
