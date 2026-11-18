/**
 * Two-tranche RSI mean-reversion bot for agent-fun/bars-replay/v1.
 *
 * Strategy (designed and tuned on the published dev window only):
 *   - Wilder RSI(21) on 1-minute closes of CBBTC.
 *   - Tranche 1: when flat and RSI <= 22, buy 40% of equity.
 *   - Tranche 2: while long and RSI <= 15, add up to 60% of equity
 *     (capped by the cash left), averaging down into a deeper dip.
 *   - Exit (sell everything): RSI >= 55, or the close falls 100 bps
 *     below the blended entry price, or 30 bars have passed since the
 *     last buy.
 *
 * Why this shape: on the dev window BTC drifts down 280 bps with tiny
 * 1-minute noise (stdev ~6.7 bps) and a ~26 bps full-size round trip.
 * Trend-following and frequent scalping both bleed fees on it; the only
 * durable edge is buying deep oversold dips (RSI <= 22) and selling the
 * recovery (RSI >= 55). The second tranche buys the dip cheaper when
 * oversold deepens. The strategy is roughly flat in the quiet half of
 * the window and strongly positive in the volatile half, so it should
 * trade more often -- and capture bigger moves -- in a livelier race
 * window while staying inside the dev gate here.
 *
 * Deterministic: the only state is the closes seen and the fills
 * reported; no clock, no environment, no randomness.
 */

import { runBars } from "./vendor/makefun-bars.ts";
import type { BarsState, Batch, OrderInput } from "./vendor/makefun-bars.ts";

const SYMBOL = "CBBTC";
const RSI_N = 21;
const RSI_BUY_1 = 22;
const RSI_BUY_2 = 15;
const RSI_SELL = 55;
const SIZE_1_BPS = 4000n; // 40% of equity for tranche 1
const SIZE_2_BPS = 6000n; // 60% of equity for tranche 2 (capped by cash)
const STOP_BPS = 100n;
const MAX_HOLD_BARS = 30;
const MAX_SLIPPAGE_BPS = 150;
const MIN_NOTIONAL = 1_000_000n; // 1 USDC in quote units

class Bot {
  private prevClose: bigint | null = null;
  private changes = 0;
  private gainSum = 0;
  private lossSum = 0;
  private avgGain: number | null = null;
  private avgLoss: number | null = null;
  private rsi: number | null = null;
  private posQty = 0n;
  private entryPx = 0n; // blended entry price, raw units
  private t2Done = false;
  private buyBar: number | null = null;

  private updateRsi(close: bigint): void {
    if (this.prevClose === null) {
      this.prevClose = close;
      return;
    }
    const change = Number(close - this.prevClose);
    this.prevClose = close;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    this.changes += 1;
    if (this.changes < RSI_N) {
      this.gainSum += gain;
      this.lossSum += loss;
      return;
    }
    if (this.changes === RSI_N) {
      this.gainSum += gain;
      this.lossSum += loss;
      this.avgGain = this.gainSum / RSI_N;
      this.avgLoss = this.lossSum / RSI_N;
    } else {
      this.avgGain = (this.avgGain! * (RSI_N - 1) + gain) / RSI_N;
      this.avgLoss = (this.avgLoss! * (RSI_N - 1) + loss) / RSI_N;
    }
    if (this.avgLoss === 0) {
      this.rsi = 100;
    } else {
      const rs = this.avgGain! / this.avgLoss;
      this.rsi = 100 - 100 / (1 + rs);
    }
  }

  private applyFills(batch: Batch): void {
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.status !== "filled") continue;
      const price = BigInt(fill.price);
      const qty = BigInt(fill.qty);
      if (fill.side === "buy") {
        if (this.posQty === 0n) {
          this.entryPx = price;
        } else {
          this.entryPx =
            (this.entryPx * this.posQty + price * qty) / (this.posQty + qty);
        }
        this.posQty += qty;
      } else {
        this.posQty -= qty;
        if (this.posQty <= 0n) {
          this.posQty = 0n;
          this.entryPx = 0n;
          this.t2Done = false;
          this.buyBar = null;
        }
      }
    }
  }

  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    this.applyFills(batch);
    if (state.warmingUp) return [];
    const close = state.close(SYMBOL);
    if (close === null) return [];
    this.updateRsi(close);
    if (this.rsi === null || this.changes < RSI_N + 1) return [];
    const holding = state.positions.get(SYMBOL);
    const qty = holding === undefined ? 0n : holding.qty;
    if (qty === 0n) {
      if (this.rsi <= RSI_BUY_1) {
        const notional = (state.equity * SIZE_1_BPS) / 10000n;
        if (notional >= MIN_NOTIONAL) {
          this.t2Done = false;
          this.buyBar = state.seq;
          return [
            {
              side: "buy",
              symbol: SYMBOL,
              notional_quote_units: notional,
              max_slippage_bps: MAX_SLIPPAGE_BPS,
            },
          ];
        }
      }
      return [];
    }
    // Long: maybe add tranche 2, else check exits.
    if (!this.t2Done && this.rsi <= RSI_BUY_2) {
      let notional = (state.equity * SIZE_2_BPS) / 10000n;
      if (notional > state.cash) notional = state.cash;
      if (notional >= MIN_NOTIONAL) {
        this.t2Done = true;
        this.buyBar = state.seq;
        return [
          {
            side: "buy",
            symbol: SYMBOL,
            notional_quote_units: notional,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          },
        ];
      }
    }
    const stopPx = (this.entryPx * (10000n - STOP_BPS)) / 10000n;
    const held = this.buyBar === null ? 0 : state.seq - this.buyBar;
    if (this.rsi >= RSI_SELL || close <= stopPx || held >= MAX_HOLD_BARS) {
      return [
        {
          side: "sell",
          symbol: SYMBOL,
          qty,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        },
      ];
    }
    return [];
  }
}

const bot = new Bot();
await runBars(bot);
