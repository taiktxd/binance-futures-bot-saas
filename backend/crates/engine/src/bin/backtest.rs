use anyhow::{ensure, Context, Result};
use chrono::{NaiveDate, Utc};
use common::{MarketTick, PositionSide, RiskProfile};
use engine::ExtremeAdaptiveCore;
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use std::{collections::BTreeMap, env, fs, path::Path};

const BAR_MS: i64 = 300_000;
const CAPITAL: Decimal = dec!(1000);
const NOTIONAL: Decimal = dec!(100);
const TAKER_FEE: Decimal = dec!(0.0005);
const SLIPPAGE: Decimal = dec!(0.0002);

struct Position {
    direction: Decimal,
    qty: Decimal,
    entry: Decimal,
    stop: Decimal,
    target: Decimal,
    funding: Decimal,
}

impl Position {
    fn open(side: PositionSide, price: Decimal) -> Self {
        let direction = if side == PositionSide::Long {
            dec!(1)
        } else {
            dec!(-1)
        };
        let entry = price * (dec!(1) + SLIPPAGE * direction);
        Self {
            direction,
            qty: NOTIONAL / entry,
            entry,
            stop: entry * (dec!(1) - dec!(0.015) * direction),
            target: entry * (dec!(1) + dec!(0.035) * direction),
            funding: dec!(0),
        }
    }

    fn exit_trigger(&self, bar: &MarketTick) -> Option<Decimal> {
        let (adverse, favorable) = if self.direction > dec!(0) {
            (bar.low_price, bar.high_price)
        } else {
            (bar.high_price, bar.low_price)
        };
        if (adverse - self.stop) * self.direction <= dec!(0) {
            // With both thresholds in one candle, assume the stop triggered first.
            let gap = (bar.open_price - self.stop) * self.direction < dec!(0);
            Some(if gap { bar.open_price } else { self.stop })
        } else if (favorable - self.target) * self.direction >= dec!(0) {
            Some(self.target)
        } else {
            None
        }
    }

    fn net_at(&self, price: Decimal) -> Decimal {
        let exit = price * (dec!(1) - SLIPPAGE * self.direction);
        ((exit - self.entry) * self.direction - (self.entry + exit) * TAKER_FEE) * self.qty
            + self.funding
    }
}

#[derive(Default)]
struct Stats {
    trades: u32,
    wins: u32,
    gains: Decimal,
    losses: Decimal,
    net: Decimal,
    peak: Decimal,
    drawdown: Decimal,
    funding: Decimal,
}

impl Stats {
    fn record(&mut self, position: Position, exit: Decimal) {
        let pnl = position.net_at(exit);
        self.net += pnl;
        self.funding += position.funding;
        self.trades += 1;
        if pnl > dec!(0) {
            self.wins += 1;
            self.gains += pnl;
        } else {
            self.losses -= pnl;
        }
    }

    fn mark(&mut self, unrealized: Decimal) {
        let equity = CAPITAL + self.net + unrealized;
        self.peak = self.peak.max(CAPITAL).max(equity);
        self.drawdown = self.drawdown.max((self.peak - equity) / self.peak);
    }
}

fn simulate(
    bars: &[MarketTick],
    funding: &BTreeMap<i64, Decimal>,
    from: i64,
    profile: RiskProfile,
) -> Stats {
    let mut strategy = ExtremeAdaptiveCore::new();
    let mut stats = Stats::default();
    let mut pending = None;
    let mut position: Option<Position> = None;

    for bar in bars {
        let time = bar.event_time_ms;
        if time >= from {
            if let Some(open) = position.as_mut() {
                if let Some(rate) = funding.get(&time) {
                    open.funding -= open.qty * bar.open_price * rate * open.direction;
                }
            }
            if let Some(side) = pending.take() {
                position = Some(Position::open(side, bar.open_price));
            }
            if let Some(exit) = position.as_ref().and_then(|open| open.exit_trigger(bar)) {
                if let Some(closed) = position.take() {
                    stats.record(closed, exit);
                }
            }
            if let Some(open) = position.as_mut() {
                let halfway = (open.entry + open.target) / dec!(2);
                if (bar.close_price - halfway) * open.direction >= dec!(0) {
                    open.stop = open.entry;
                }
            }
            stats.mark(
                position
                    .as_ref()
                    .map_or(dec!(0), |open| open.net_at(bar.close_price)),
            );
        }
        let signal = strategy.on_closed_kline(bar);
        if position.is_none() && time + BAR_MS >= from {
            pending = signal
                .filter(|signal| signal.qualifies_for(profile))
                .map(|signal| signal.side);
        }
    }
    if let (Some(open), Some(last)) = (position, bars.last()) {
        stats.record(open, last.close_price);
        stats.mark(dec!(0));
    }
    stats
}

fn load_history(dir: &Path, symbol: &str) -> Result<(Vec<MarketTick>, BTreeMap<i64, Decimal>)> {
    let mut bars = Vec::new();
    let mut funding = BTreeMap::new();
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !name.ends_with(".csv") {
            continue;
        }
        let is_kline = name.starts_with(&format!("{symbol}-5m-"));
        if !is_kline && !name.starts_with(&format!("{symbol}-fundingRate-")) {
            continue;
        }
        for (index, line) in fs::read_to_string(&path)?.lines().enumerate() {
            let line = line.trim_start_matches('\u{feff}');
            if index == 0 && (line.starts_with("open_time,") || line.starts_with("calc_time,")) {
                continue;
            }
            let fields: Vec<_> = line.split(',').collect();
            let row = || -> Result<()> {
                let get = |i| fields.get(i).copied().context("missing CSV column");
                let time: i64 = get(0)?.parse()?;
                let price = |i| -> Result<Decimal> { Ok(get(i)?.parse()?) };
                if is_kline {
                    let (open, high, low, close) = (price(1)?, price(2)?, price(3)?, price(4)?);
                    ensure!(
                        low > dec!(0) && low <= open.min(close) && high >= open.max(close),
                        "invalid OHLC"
                    );
                    bars.push(MarketTick {
                        symbol: symbol.to_owned(),
                        event_time_ms: time,
                        mark_price: close,
                        open_price: open,
                        high_price: high,
                        low_price: low,
                        close_price: close,
                        change_pct_24h: dec!(0),
                        is_kline_closed: true,
                    });
                } else {
                    // The archive timestamp can trail the nominal funding boundary by milliseconds.
                    let boundary = time.div_euclid(BAR_MS) * BAR_MS;
                    ensure!(
                        funding.insert(boundary, price(2)?).is_none(),
                        "duplicate funding time"
                    );
                }
                Ok(())
            };
            let mut row = row;
            row().with_context(|| format!("{}:{}", path.display(), index + 1))?;
        }
    }
    bars.sort_unstable_by_key(|bar| bar.event_time_ms);
    ensure!(
        !bars.is_empty() && !funding.is_empty(),
        "missing candles or funding for {symbol}"
    );
    ensure!(
        bars.windows(2)
            .all(|pair| pair[1].event_time_ms - pair[0].event_time_ms == BAR_MS),
        "gaps or duplicates in candles"
    );
    Ok((bars, funding))
}

fn main() -> Result<()> {
    let args: Vec<_> = env::args().skip(1).collect();
    let [directory, symbol, from, until] = args.as_slice() else {
        anyhow::bail!(
            "usage: backtest <archive-csv-dir> <symbol> <from YYYY-MM-DD> <until YYYY-MM-DD>"
        );
    };
    let date_ms = |input: &str| -> Result<i64> {
        let date = NaiveDate::parse_from_str(input, "%Y-%m-%d")?;
        Ok(date
            .and_hms_opt(0, 0, 0)
            .context("invalid UTC date")?
            .and_utc()
            .timestamp_millis())
    };
    let (start, end) = (date_ms(from)?, date_ms(until)?);
    ensure!(
        start < end && end <= Utc::now().timestamp_millis(),
        "invalid backtest window"
    );
    let (mut bars, funding) = load_history(Path::new(directory), symbol)?;
    bars.retain(|bar| bar.event_time_ms < end);
    ensure!(
        bars.iter().filter(|bar| bar.event_time_ms < start).count() >= 200,
        "need at least 200 warmup candles"
    );
    ensure!(
        bars.last()
            .is_some_and(|bar| bar.event_time_ms + BAR_MS == end),
        "incomplete window"
    );
    ensure!(
        funding
            .range(..=start)
            .next_back()
            .is_some_and(|(time, _)| start - time <= 28_800_000)
            && funding
                .range(..end)
                .next_back()
                .is_some_and(|(time, _)| end - time <= 28_800_000)
            && funding
                .range(start..end)
                .map(|(time, _)| *time)
                .collect::<Vec<_>>()
                .windows(2)
                .all(|pair| pair[1] - pair[0] <= 28_800_000),
        "missing funding in requested window"
    );

    println!("{symbol} UTC {from} .. {until} (exclusive)");
    println!("profile,trades,win_rate_pct,profit_factor,net_usdt,max_drawdown_pct,funding_usdt");
    for profile in [
        RiskProfile::Safe,
        RiskProfile::Balanced,
        RiskProfile::Growth,
    ] {
        let stats = simulate(&bars, &funding, start, profile);
        let win_rate = if stats.trades == 0 {
            dec!(0)
        } else {
            Decimal::from(stats.wins) / Decimal::from(stats.trades) * dec!(100)
        };
        let factor = if stats.losses > dec!(0) {
            format!("{:.3}", stats.gains / stats.losses)
        } else if stats.gains > dec!(0) {
            "inf".to_owned()
        } else {
            "n/a".to_owned()
        };
        println!(
            "{profile:?},{},{win_rate:.2},{factor},{:.2},{:.3},{:.4}",
            stats.trades,
            stats.net,
            stats.drawdown * dec!(100),
            stats.funding
        );
    }
    Ok(())
}
