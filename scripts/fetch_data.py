#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
中证红利 40日收益差 — 数据管道

直连 Wind MCP 无状态 HTTP 接口，拉取：
  H00922.CSI  中证红利全收益指数
  881001.WI   万得全A（Wind 标注「收益处理方式 = 全收益指数」）
  H00985.CSI  中证全指全收益指数（备用代理口径）

计算 40 日滚动收益差，跑基准参数回测，输出 data/data.json。
同时产出 data/data.js（同一份数据内联为 window.__SPREAD_DATA__），
让 index.html 双击直开（file://）也能显示，不依赖 HTTP 服务。
零第三方依赖（仅 Python 标准库），可直接在 GitHub Actions 运行。

用法：
  WIND_API_KEY=xxx python3 scripts/fetch_data.py
  WIND_API_KEY=xxx python3 scripts/fetch_data.py --out data/data.json
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone, timedelta

WIND_ENDPOINT = "https://mcp.wind.com.cn/vserver_index_data/mcp/"
WINDOW = 40                 # 滚动窗口（交易日）
TRADING_DAYS_PER_YEAR = 252
START_DATE = "20131216"     # 中证红利改为股息率加权之日

DIVIDEND = ("H00922.CSI", "中证红利全收益指数")
MARKET_WIND = ("881001.WI", "万得全A（全收益）")
MARKET_PROXY = ("H00985.CSI", "中证全指全收益指数")

PRESETS = [
    ("大白优化版", -1.0, 5.0),
    ("张老师原版", -5.0, 10.0),
    ("窄格版", -2.0, 3.0),
    ("宽卖版", -1.0, 8.0),
]


# ───────────────────────── Wind MCP 调用 ─────────────────────────

def wind_call(tool_name, arguments, api_key, retries=3):
    """调用 Wind MCP 无状态接口。streamable-http-stateless，无需握手。"""
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": tool_name, "arguments": arguments},
    }
    body = json.dumps(payload).encode("utf-8")
    headers = {
        "Authorization": "Bearer " + api_key,
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }

    last_err = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(WIND_ENDPOINT, data=body,
                                         headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=60) as resp:
                text = resp.read().decode("utf-8", errors="replace")
            return _parse_mcp_text(text)
        except urllib.error.HTTPError as e:
            last_err = "HTTP %s: %s" % (e.code, e.read().decode("utf-8", "replace")[:300])
        except Exception as e:                      # noqa: BLE001
            last_err = "%s: %s" % (type(e).__name__, e)
        print("  [warn] 第 %d 次调用失败：%s" % (attempt + 1, last_err), file=sys.stderr)
    raise RuntimeError("Wind MCP 调用失败（%s）：%s" % (tool_name, last_err))


def _parse_mcp_text(text):
    """兼容 SSE（data: {...}）与纯 JSON 两种返回。"""
    raw = None
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            raw = line[5:].strip()
            break
    if raw is None:
        raw = text.strip()
    if not raw:
        raise RuntimeError("Wind MCP 返回空内容")
    envelope = json.loads(raw)
    if "error" in envelope and envelope["error"]:
        raise RuntimeError("Wind MCP 业务错误：%s" % envelope["error"])
    content = envelope.get("result", {}).get("content") or []
    if not content:
        raise RuntimeError("Wind MCP 返回无 content 字段")
    inner = content[0].get("text", "")
    data = json.loads(inner)
    if data.get("error"):
        raise RuntimeError("Wind MCP 数据错误：%s" % data["error"])
    return data.get("data") or {}


def fetch_close_series(windcode, api_key, begin=START_DATE, end=None):
    """取指数日线收盘价，返回 {yyyymmdd: float}。"""
    end = end or datetime.now().strftime("%Y%m%d")
    data = wind_call("get_index_kline",
                     {"windcode": windcode, "begin_date": begin, "end_date": end},
                     api_key)
    cols = [c["name"] for c in data.get("columns", [])]
    if "TIME" not in cols or "MATCH" not in cols:
        raise RuntimeError("%s 返回列异常：%s" % (windcode, cols))
    i_t, i_c = cols.index("TIME"), cols.index("MATCH")
    out = {}
    for row in data.get("rows", []):
        day = str(row[i_t])[:10].replace("-", "")
        try:
            out[day] = float(row[i_c])
        except (TypeError, ValueError):
            continue
    return out


# ───────────────────────── 计算 ─────────────────────────

def rolling_return(closes, dates, i, window=WINDOW):
    """dates[i] 当天的 window 日滚动收益率（%）。数据不足返回 None。"""
    if i < window:
        return None
    base = closes.get(dates[i - window])
    cur = closes.get(dates[i])
    if not base or not cur:
        return None
    return (cur / base - 1.0) * 100.0


def build_series(dividend, market, dates):
    """返回 (spread 列表, 红利滚动收益列表, 市场滚动收益列表)，前 window 项为 None。"""
    spread, div_ret, mkt_ret = [], [], []
    for i in range(len(dates)):
        rd = rolling_return(dividend, dates, i)
        rm = rolling_return(market, dates, i)
        if rd is None or rm is None:
            spread.append(None)
            div_ret.append(None)
            mkt_ret.append(None)
        else:
            spread.append(round(rd - rm, 3))
            div_ret.append(round(rd, 3))
            mkt_ret.append(round(rm, 3))
    return spread, div_ret, mkt_ret


def backtest(div_nav, spread, buy_th, sell_th):
    """
    收益差择时回测。

    成交口径：信号 = spread[i-1]，pos[i] 决定第 i 日是否吃 r_i = div_nav[i]/div_nav[i-1]。
    即「第 i-1 日（信号日）收盘成交」，0 日延迟。
    建仓 pos[entry]=1 => 第 entry-1 日收盘买入；平仓 pos[out]=0 => 第 out-1 日收盘卖出。
    单笔实现收益 = div_nav[out-1] / div_nav[entry-1] - 1。
    trades 中的 buy/sell 存「成交日」下标（= 信号日下标），days = sell - buy。
    """
    n = len(div_nav)
    pos = [0] * n
    trades = []
    entry_i = None

    for i in range(1, n):
        prev_sig = spread[i - 1]
        cur = pos[i - 1]
        if prev_sig is None:
            pos[i] = cur
        elif cur == 0 and prev_sig < buy_th:
            pos[i] = 1
            entry_i = i
        elif cur == 1 and prev_sig > sell_th:
            pos[i] = 0
            if entry_i is not None:
                ret = (div_nav[i - 1] / div_nav[entry_i - 1] - 1.0) * 100.0
                trades.append({"buy": entry_i - 1, "sell": i - 1, "days": i - entry_i,
                               "ret": round(ret, 2)})
                entry_i = None
        else:
            pos[i] = cur

    if entry_i is not None:      # 期末仍持有
        ret = (div_nav[-1] / div_nav[entry_i - 1] - 1.0) * 100.0
        trades.append({"buy": entry_i - 1, "sell": n - 1, "days": n - entry_i,
                       "ret": round(ret, 2), "open": True})

    # 净值曲线
    nav = [1.0] * n
    for i in range(1, n):
        r = div_nav[i] / div_nav[i - 1] - 1.0
        nav[i] = nav[i - 1] * (1.0 + (r if pos[i] else 0.0))

    years = (n - 1) / float(TRADING_DAYS_PER_YEAR)
    total = (nav[-1] - 1.0) * 100.0
    annual = ((nav[-1] ** (1.0 / years)) - 1.0) * 100.0 if years > 0 else 0.0

    peak, mdd = nav[0], 0.0
    for v in nav:
        peak = max(peak, v)
        mdd = min(mdd, v / peak - 1.0)

    closed = [t for t in trades if not t.get("open")]
    wins = [t for t in closed if t["ret"] > 0]
    losses = [t for t in closed if t["ret"] <= 0]
    win_rate = (len(wins) / len(closed) * 100.0) if closed else 0.0
    avg_win = (sum(t["ret"] for t in wins) / len(wins)) if wins else 0.0
    avg_loss = (abs(sum(t["ret"] for t in losses) / len(losses))) if losses else 0.0
    pl_ratio = (avg_win / avg_loss) if avg_loss > 0 else None

    hold_days = sum(1 for p in pos if p == 1)
    hold_trades = [t for t in trades if not t.get("open")]

    return {
        "nav": nav,
        "trades": trades,
        "stats": {
            "total_return": round(total, 2),
            "annual_return": round(annual, 2),
            "max_drawdown": round(mdd * 100.0, 2),
            "trade_count": len(closed),
            "win_rate": round(win_rate, 1),
            "pl_ratio": round(pl_ratio, 2) if pl_ratio is not None else None,
            "avg_win": round(avg_win, 2),
            "avg_loss": round(-avg_loss, 2),
            "avg_hold_days": round(sum(t["days"] for t in hold_trades) / len(hold_trades)) if hold_trades else 0,
            "hold_ratio": round(hold_days * 100.0 / n, 1),
            "open_position": bool(trades and trades[-1].get("open")),
        },
    }


def buy_and_hold(div_nav):
    nav = [v / div_nav[0] for v in div_nav]
    years = (len(nav) - 1) / float(TRADING_DAYS_PER_YEAR)
    total = (nav[-1] - 1.0) * 100.0
    annual = ((nav[-1] ** (1.0 / years)) - 1.0) * 100.0 if years > 0 else 0.0
    peak, mdd = nav[0], 0.0
    for v in nav:
        peak = max(peak, v)
        mdd = min(mdd, v / peak - 1.0)
    return {
        "nav": nav,
        "stats": {"total_return": round(total, 2),
                  "annual_return": round(annual, 2),
                  "max_drawdown": round(mdd * 100.0, 2)},
    }


def percentile_of(values, x):
    clean = [v for v in values if v is not None]
    if not clean:
        return None
    return round(sum(1 for v in clean if v <= x) * 100.0 / len(clean), 1)


def find_buy_days(dates, spread, buy_th):
    """连续跌破买入线的区段起点，用于主图标点。"""
    out = []
    prev = False
    for i, s in enumerate(spread):
        cur = (s is not None and s < buy_th)
        if cur and not prev:
            out.append(i)
        prev = cur
    return out


def find_sell_days(dates, spread, sell_th):
    out = []
    prev = False
    for i, s in enumerate(spread):
        cur = (s is not None and s > sell_th)
        if cur and not prev:
            out.append(i)
        prev = cur
    return out


# ───────────────────────── 主流程 ─────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join("data", "data.json"))
    ap.add_argument("--start", default=START_DATE)
    args = ap.parse_args()

    api_key = os.environ.get("WIND_API_KEY", "").strip()
    if not api_key:
        print("错误：未设置环境变量 WIND_API_KEY", file=sys.stderr)
        return 2

    end = datetime.now().strftime("%Y%m%d")
    print("拉取区间：%s → %s" % (args.start, end))

    series = {}
    for code, name in [DIVIDEND, MARKET_WIND, MARKET_PROXY]:
        print("  拉取 %s (%s) ..." % (code, name))
        series[code] = fetch_close_series(code, api_key, args.start, end)
        print("    %d 个交易日" % len(series[code]))

    div_c, wind_c, proxy_c = (series[DIVIDEND[0]], series[MARKET_WIND[0]],
                              series[MARKET_PROXY[0]])

    # 日期取三方交集，保证口径可比
    dates = sorted(set(div_c) & set(wind_c) & set(proxy_c))
    if len(dates) < WINDOW + 20:
        print("错误：共同交易日不足（%d）" % len(dates), file=sys.stderr)
        return 3
    print("共同交易日：%d（%s → %s）" % (len(dates), dates[0], dates[-1]))

    div_nav = [div_c[d] for d in dates]
    base = div_nav[0]
    div_nav = [round(v / base * 100.0, 4) for v in div_nav]

    spread_wind, div_ret, mkt_ret = build_series(div_c, wind_c, dates)
    spread_proxy, _, _ = build_series(div_c, proxy_c, dates)

    last_i = len(dates) - 1
    last_date = dates[last_i]
    n3y = 750
    pct_3y = percentile_of(spread_wind[max(0, last_i - n3y):last_i + 1], spread_wind[last_i])
    pct_all = percentile_of(spread_wind, spread_wind[last_i])

    print("最新 %s：Wind 口径收益差 = %.2f%%，代理口径 = %.2f%%"
          % (last_date, spread_wind[last_i], spread_proxy[last_i]))

    bh = buy_and_hold(div_nav)

    presets = []
    for name, buy_th, sell_th in PRESETS:
        bt = backtest(div_nav, spread_wind, buy_th, sell_th)
        st = bt["stats"]
        st["excess_annual"] = round(st["annual_return"] - bh["stats"]["annual_return"], 2)
        presets.append({
            "name": name,
            "buy": buy_th,
            "sell": sell_th,
            "wind": st,
            "buy_days": find_buy_days(dates, spread_wind, buy_th),
            "sell_days": find_sell_days(dates, spread_wind, sell_th),
            "trades": bt["trades"],
            "nav_sample": [round(bt["nav"][i], 4)
                           for i in range(0, len(dates), max(1, len(dates) // 400))],
        })
        print("  预设「%s」(%+.0f%%/%+.0f%%)：累计 %.1f%%  年化 %.2f%%  "
              "交易 %d 次  胜率 %.1f%%  回撤 %.2f%%"
              % (name, buy_th, sell_th, st["total_return"], st["annual_return"],
                 st["trade_count"], st["win_rate"], st["max_drawdown"]))

    tz = timezone(timedelta(hours=8))
    payload = {
        "updated": datetime.now(tz).strftime("%Y-%m-%dT%H:%M:%S+08:00"),
        "meta": {
            "dividend": {"code": DIVIDEND[0], "name": DIVIDEND[1]},
            "market_wind": {"code": MARKET_WIND[0], "name": MARKET_WIND[1]},
            "market_proxy": {"code": MARKET_PROXY[0], "name": MARKET_PROXY[1]},
            "window": WINDOW,
            "start": dates[0],
            "end": last_date,
            "trading_days": len(dates),
            "source": "Wind MCP (index_data.get_index_kline)",
        },
        "series": {
            "dates": dates,
            "div_nav": div_nav,
            "spread_wind": spread_wind,
            "spread_proxy": spread_proxy,
            "div_ret40": div_ret,
            "mkt_ret40": mkt_ret,
        },
        "latest": {
            "date": last_date,
            "spread_wind": spread_wind[last_i],
            "spread_proxy": spread_proxy[last_i],
            "pct_3y": pct_3y,
            "pct_all": pct_all,
            "div_close": round(div_nav[last_i], 2),
            "mkt_close": round(wind_c[last_date], 2),
        },
        "buyhold": {"stats": bh["stats"]},
        "presets": presets,
        "default_preset": PRESETS[0][0],
    }

    out_path = args.out
    out_dir = os.path.dirname(out_path)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    print("已写出 %s（%.1f KB）" % (out_path, os.path.getsize(out_path) / 1024.0))

    # 同步产出 data.js：把同一份数据内联成 window.__SPREAD_DATA__，
    # 让 index.html 双击（file://）也能直接显示，绕开 fetch 的同源策略限制。
    js_path = os.path.join(out_dir, "data.js") if out_dir else "data.js"
    with open(js_path, "w", encoding="utf-8") as f:
        f.write("/* 自动生成，请勿手动编辑。来源：scripts/fetch_data.py */\n")
        f.write("window.__SPREAD_DATA__=")
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")
    print("已写出 %s（%.1f KB）" % (js_path, os.path.getsize(js_path) / 1024.0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
