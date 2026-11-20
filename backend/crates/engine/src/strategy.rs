use common::{MarketTick, PositionSide, RiskProfile};
use rust_decimal::prelude::{FromPrimitive, ToPrimitive};
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use std::collections::HashMap;
use ta::indicators::{
    AverageTrueRange, BollingerBands, ExponentialMovingAverage, MovingAverageConvergenceDivergence,
    RelativeStrengthIndex,
};
use ta::{DataItem, Next};

/// Single unified adaptive strategy output produced by `ExtremeAdaptiveCore`.
/// Users never pick internal strategy names; they configure RiskProfile (SAFE / BALANCED / GROWTH),
/// and the engine filters signals by `confluence_score` and adapts SL/TP to volatility.
#[derive(Debug, Clone)]
pub struct ExtremeSignal {
    pub symbol: String,
    pub side: PositionSide,
    pub entry_price: Decimal,
    pub atr: Decimal,
    pub confluence_score: u8,
    pub regime: MarketRegime,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarketRegime {
    Trending,
    MeanReversion,
}

impl ExtremeSignal {
    /// Returns true if this signal satisfies the minimum confluence score required by the user's RiskProfile.
    pub fn qualifies_for(&self, profile: RiskProfile) -> bool {
        let min_score = match profile {
            RiskProfile::Safe => 80,
            RiskProfile::Balanced => 70,
            RiskProfile::Growth => 60,
        };
        self.confluence_score >= min_score
    }
}

struct SymbolEngineState {
    ema_fast: ExponentialMovingAverage,
    ema_mid: ExponentialMovingAverage,
    ema_slow: ExponentialMovingAverage,
    ema_macro: ExponentialMovingAverage,
    rsi: RelativeStrengthIndex,
    macd: MovingAverageConvergenceDivergence,
    atr: AverageTrueRange,
    bb: BollingerBands,
    prev_fast: Option<f64>,
    prev_mid: Option<f64>,
    prev_hist: Option<f64>,
    bars_seen: u32,
    cooldown_bars: u8,
}

impl SymbolEngineState {
    fn new() -> Option<Self> {
        Some(Self {
            ema_fast: ExponentialMovingAverage::new(9).ok()?,
            ema_mid: ExponentialMovingAverage::new(21).ok()?,
            ema_slow: ExponentialMovingAverage::new(50).ok()?,
            ema_macro: ExponentialMovingAverage::new(200).ok()?,
            rsi: RelativeStrengthIndex::new(14).ok()?,
            macd: MovingAverageConvergenceDivergence::new(12, 26, 9).ok()?,
            atr: AverageTrueRange::new(14).ok()?,
            bb: BollingerBands::new(20, 2.0).ok()?,
            prev_fast: None,
            prev_mid: None,
            prev_hist: None,
            bars_seen: 0,
            cooldown_bars: 0,
        })
    }
}

/// EXTREME Single Master Strategy Engine:
/// Combines multi-timeframe EMA Ribbon (9/21/50/200), MACD momentum acceleration,
/// RSI regime filtering, Bollinger volatility bands, ATR liquidity gating, and anti-whiplash cooldown
/// into a single high-precision 0..100 confluence scorer.
pub struct ExtremeAdaptiveCore {
    states: HashMap<String, SymbolEngineState>,
}

impl Default for ExtremeAdaptiveCore {
    fn default() -> Self {
        Self::new()
    }
}

impl ExtremeAdaptiveCore {
    pub fn new() -> Self {
        Self {
            states: HashMap::new(),
        }
    }

    /// Evaluates a closed kline bar and emits at most ONE high-conviction directional signal.
    /// Floating-point math is strictly confined to the `ta` crate boundary; outputs are exact Decimal.
    pub fn on_closed_kline(&mut self, tick: &MarketTick) -> Option<ExtremeSignal> {
        if !tick.is_kline_closed {
            return None;
        }

        if !self.states.contains_key(&tick.symbol) {
            let initialized = SymbolEngineState::new()?;
            self.states.insert(tick.symbol.clone(), initialized);
        }

        let state = self.states.get_mut(&tick.symbol)?;

        let (o, h, l, c) = (
            tick.open_price.to_f64()?,
            tick.high_price.to_f64()?,
            tick.low_price.to_f64()?,
            tick.close_price.to_f64()?,
        );
        if c <= 0.0 {
            return None;
        }

        let bar = DataItem::builder()
            .open(o)
            .high(h)
            .low(l)
            .close(c)
            .volume(1.0)
            .build()
            .ok()?;

        let fast = state.ema_fast.next(c);
        let mid = state.ema_mid.next(c);
        let slow = state.ema_slow.next(c);
        let macro_ema = state.ema_macro.next(c);
        let rsi = state.rsi.next(c);
        let macd = state.macd.next(c);
        let atr_f64 = state.atr.next(&bar);
        let bb = state.bb.next(c);

        state.bars_seen = state.bars_seen.saturating_add(1);
        let prev_fast = state.prev_fast.replace(fast);
        let prev_mid = state.prev_mid.replace(mid);
        let prev_hist = state.prev_hist.replace(macd.histogram);

        if state.cooldown_bars > 0 {
            state.cooldown_bars -= 1;
            return None;
        }

        // Warmup minimum to stabilize EMA50/ATR14/BB20 before live capital deployment.
        if state.bars_seen < 55 {
            return None;
        }

        // Volatility gate: skip dead flat markets (<0.08% ATR) and extreme flash crashes (>4.5% ATR).
        let atr_pct = (atr_f64 / c) * 100.0;
        if !(0.08..=4.5).contains(&atr_pct) {
            return None;
        }

        let trend_spread_pct = ((fast - slow).abs() / c) * 100.0;
        let regime = if trend_spread_pct >= 0.22 {
            MarketRegime::Trending
        } else {
            MarketRegime::MeanReversion
        };

        let mut long_score: u8 = 0;
        let mut short_score: u8 = 0;

        match regime {
            MarketRegime::Trending => {
                // 1. EMA Ribbon Alignment (up to 35 pts)
                if fast > mid && mid > slow {
                    long_score += 25;
                    if c > macro_ema {
                        long_score += 10;
                    }
                } else if fast < mid && mid < slow {
                    short_score += 25;
                    if c < macro_ema {
                        short_score += 10;
                    }
                }

                // 2. Crossover / Pullback Trigger (25 pts)
                if let (Some(pf), Some(pm)) = (prev_fast, prev_mid) {
                    if (pf <= pm && fast > mid) || (l <= mid && c > fast) {
                        long_score += 25;
                    }
                    if (pf >= pm && fast < mid) || (h >= mid && c < fast) {
                        short_score += 25;
                    }
                }

                // 3. MACD Histogram Acceleration (20 pts)
                if let Some(ph) = prev_hist {
                    if macd.histogram > 0.0 && macd.histogram > ph {
                        long_score += 20;
                    }
                    if macd.histogram < 0.0 && macd.histogram < ph {
                        short_score += 20;
                    }
                }

                // 4. RSI Healthy Trend Zone (20 pts — avoids chasing overbought/oversold extremes)
                if (48.0..=68.0).contains(&rsi) {
                    long_score += 20;
                }
                if (32.0..=52.0).contains(&rsi) {
                    short_score += 20;
                }
            }
            MarketRegime::MeanReversion => {
                // Range-bound precision entries at Bollinger extremes with RSI + MACD turn confirmation
                if c <= bb.lower && rsi <= 34.0 {
                    long_score += 55;
                    if let Some(ph) = prev_hist {
                        if macd.histogram > ph {
                            long_score += 25;
                        }
                    }
                    if c >= macro_ema * 0.985 {
                        long_score += 10;
                    }
                }
                if c >= bb.upper && rsi >= 66.0 {
                    short_score += 55;
                    if let Some(ph) = prev_hist {
                        if macd.histogram < ph {
                            short_score += 25;
                        }
                    }
                    if c <= macro_ema * 1.015 {
                        short_score += 10;
                    }
                }
            }
        }

        let (side, score) = if long_score >= 60 && long_score > short_score {
            (PositionSide::Long, long_score)
        } else if short_score >= 60 && short_score > long_score {
            (PositionSide::Short, short_score)
        } else {
            return None;
        };

        // Anti-whiplash cooldown: skip next 3 bars after emitting an entry signal.
        state.cooldown_bars = 3;

        let atr_dec = Decimal::from_f64(atr_f64)
            .filter(|d| *d > dec!(0))
            .unwrap_or_else(|| (tick.close_price * dec!(0.005)).round_dp(8));

        Some(ExtremeSignal {
            symbol: tick.symbol.clone(),
            side,
            entry_price: tick.close_price,
            atr: atr_dec,
            confluence_score: score,
            regime,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn risk_profile_thresholds_enforce_stricter_confluence_for_safe() {
        let sig = ExtremeSignal {
            symbol: "BTCUSDT".to_string(),
            side: PositionSide::Long,
            entry_price: dec!(65000),
            atr: dec!(350),
            confluence_score: 72,
            regime: MarketRegime::Trending,
        };
        assert!(!sig.qualifies_for(RiskProfile::Safe));
        assert!(sig.qualifies_for(RiskProfile::Balanced));
        assert!(sig.qualifies_for(RiskProfile::Growth));
    }

    #[test]
    fn emits_no_signal_before_warmup_completes() {
        let mut engine = ExtremeAdaptiveCore::new();
        for i in 0..50 {
            let p = Decimal::from(60000 + i * 20);
            let tick = MarketTick {
                symbol: "BTCUSDT".to_string(),
                mark_price: p,
                open_price: p - dec!(10),
                high_price: p + dec!(15),
                low_price: p - dec!(15),
                close_price: p,
                change_pct_24h: dec!(1.2),
                is_kline_closed: true,
                event_time_ms: i64::from(i) * 300_000,
            };
            assert!(engine.on_closed_kline(&tick).is_none());
        }
    }
}
