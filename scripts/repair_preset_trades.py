#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
离线修复 data/data.json 与 data/data.js 中 presets[].trades 的口径错误。

背景（Bug）：
  原 backtest() 用 div_nav[out] / div_nav[entry] 计算单笔收益，但净值引擎
  实际是「信号日收盘成交」，单笔实现收益应为 div_nav[out-1] / div_nav[entry-1]。
  结果：交易明细逐笔连乘 ≠ 策略累计收益（相差一个交易日的错位）。
  fetch_data.py 中该函数已改为正确口径，本脚本无需联网，直接用现有
  序列重算 presets 的 trades / stats，并做「连乘 == 累计收益」自校验。

用法：
  python3 scripts/repair_preset_trades.py
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from fetch_data import backtest, buy_and_hold  # noqa: E402

DATA_JSON = os.path.join(ROOT, "data", "data.json")
DATA_JS = os.path.join(ROOT, "data", "data.js")


def check(p):
    """逐笔连乘 vs 策略累计收益，返回 (ok, 连乘值, 累计值)"""
    prod = 1.0
    for t in p["trades"]:
        prod *= (1.0 + t["ret"] / 100.0)
    got = (prod - 1.0) * 100.0
    want = p["wind"]["total_return"]
    return abs(got - want) < 0.05, got, want


def main():
    with open(DATA_JSON, "r", encoding="utf-8") as f:
        payload = json.load(f)

    dates = payload["series"]["dates"]
    div_nav = payload["series"]["div_nav"]
    spread_wind = payload["series"]["spread_wind"]

    bh = buy_and_hold(div_nav)
    print("买入持有：累计 %.2f%%  年化 %.2f%%" % (bh["stats"]["total_return"],
                                                bh["stats"]["annual_return"]))
    print()

    all_ok = True
    for p in payload["presets"]:
        old_ok, old_prod, old_tot = check(p)
        bt = backtest(div_nav, spread_wind, p["buy"], p["sell"])
        st = bt["stats"]
        st["excess_annual"] = round(st["annual_return"] - bh["stats"]["annual_return"], 2)
        p["wind"] = st
        p["trades"] = bt["trades"]
        p["nav_sample"] = [round(v, 4) for v in
                           [bt["nav"][i] for i in range(0, len(dates), max(1, len(dates) // 400))]]

        new_ok, new_prod, new_tot = check(p)
        all_ok = all_ok and new_ok
        print("「%s」(%+.0f%%/%+.0f%%)" % (p["name"], p["buy"], p["sell"]))
        print("    修复前  连乘 %+9.2f%%  累计 %+9.2f%%  差 %+8.2f pct   %s"
              % (old_prod, old_tot, old_prod - old_tot, "OK" if old_ok else "不一致 ←BUG"))
        print("    修复后  连乘 %+9.2f%%  累计 %+9.2f%%  差 %+8.2f pct   %s"
              % (new_prod, new_tot, new_prod - new_tot, "OK" if new_ok else "仍不一致"))
        print("    交易 %d 次  胜率 %.1f%%  盈亏比 %s  均持有 %d 天  回撤 %.2f%%"
              % (st["trade_count"], st["win_rate"], st["pl_ratio"],
                 st["avg_hold_days"], st["max_drawdown"]))
        print("    首笔 %s → %s  %+.2f%%"
              % (dates[p["trades"][0]["buy"]], dates[p["trades"][0]["sell"]],
                 p["trades"][0]["ret"]))
        print("    末笔 %s → %s  %+.2f%%%s"
              % (dates[p["trades"][-1]["buy"]], dates[p["trades"][-1]["sell"]],
                 p["trades"][-1]["ret"], "（持有中）" if p["trades"][-1].get("open") else ""))
        print()

    if not all_ok:
        print("!! 自校验未通过，未写出文件")
        return 1

    with open(DATA_JSON, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    with open(DATA_JS, "w", encoding="utf-8") as f:
        f.write("/* 自动生成，请勿手动编辑。来源：scripts/fetch_data.py */\n")
        f.write("window.__SPREAD_DATA__=")
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")
    print("已写出 data.json (%.1f KB) / data.js (%.1f KB)"
          % (os.path.getsize(DATA_JSON) / 1024.0, os.path.getsize(DATA_JS) / 1024.0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
