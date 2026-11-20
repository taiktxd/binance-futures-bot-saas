use common::MarketTick;
use futures_util::{SinkExt, StreamExt};
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use serde::Deserialize;
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;
use tokio::time::{interval, sleep};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{error, info, warn};

/// Spawns a single shared Combined WebSocket stream for BTCUSDT, ETHUSDT, and Gold (XAUUSDT or PAXGUSDT).
/// Uses Ping/Pong keep-alive and Exponential Backoff reconnect to remain resilient on 1 vCPU / 2GB RAM VPS.
pub fn spawn_market_data_stream(
    ws_base_url: String,
    active_gold_symbol: String,
    tx: broadcast::Sender<MarketTick>,
    is_connected: Arc<AtomicBool>,
) {
    tokio::spawn(async move {
        let gold_lower = active_gold_symbol.to_lowercase();
        let streams = [
            "btcusdt@kline_5m".to_string(),
            "ethusdt@kline_5m".to_string(),
            format!("{gold_lower}@kline_5m"),
            "btcusdt@markPrice@1s".to_string(),
            "ethusdt@markPrice@1s".to_string(),
            format!("{gold_lower}@markPrice@1s"),
        ]
        .join("/");

        let endpoint = format!(
            "{}/stream?streams={streams}",
            ws_base_url.trim_end_matches('/')
        );

        let mut backoff_secs: u64 = 1;
        let mut last_open_price: HashMap<String, Decimal> = HashMap::new();

        loop {
            info!(endpoint = %endpoint, "connecting to binance futures combined stream");
            match connect_async(&endpoint).await {
                Ok((ws_stream, _)) => {
                    is_connected.store(true, Ordering::Relaxed);
                    backoff_secs = 1;
                    info!("binance futures combined stream connected");

                    let (mut write, mut read) = ws_stream.split();
                    let mut ping_ticker = interval(Duration::from_secs(30));

                    loop {
                        tokio::select! {
                            _ = ping_ticker.tick() => {
                                if let Err(err) = write.send(Message::Ping(Vec::new())).await {
                                    warn!(error = %err, "websocket ping failed; reconnecting");
                                    break;
                                }
                            }
                            maybe_msg = read.next() => {
                                match maybe_msg {
                                    Some(Ok(Message::Text(text))) => {
                                        if let Some(tick) = parse_combined_frame(&text, &mut last_open_price) {
                                            let _ = tx.send(tick);
                                        }
                                    }
                                    Some(Ok(Message::Ping(payload))) => {
                                        let _ = write.send(Message::Pong(payload)).await;
                                    }
                                    Some(Ok(Message::Close(_))) | None => {
                                        warn!("binance websocket closed by peer");
                                        break;
                                    }
                                    Some(Err(err)) => {
                                        error!(error = %err, "binance websocket read error");
                                        break;
                                    }
                                    _ => {}
                                }
                            }
                        }
                    }
                    is_connected.store(false, Ordering::Relaxed);
                }
                Err(err) => {
                    is_connected.store(false, Ordering::Relaxed);
                    error!(error = %err, backoff_secs = backoff_secs, "binance websocket connect failed");
                }
            }

            sleep(Duration::from_secs(backoff_secs)).await;
            backoff_secs = (backoff_secs * 2).min(60);
        }
    });
}

#[derive(Deserialize)]
struct CombinedFrame {
    stream: String,
    data: serde_json::Value,
}

fn parse_combined_frame(
    raw: &str,
    last_open_price: &mut HashMap<String, Decimal>,
) -> Option<MarketTick> {
    let frame: CombinedFrame = serde_json::from_str(raw).ok()?;

    if frame.stream.contains("@kline_") {
        let symbol = frame.data.get("s")?.as_str()?.to_uppercase();
        let k = frame.data.get("k")?;
        let open = Decimal::from_str(k.get("o")?.as_str()?).ok()?;
        let high = Decimal::from_str(k.get("h")?.as_str()?).ok()?;
        let low = Decimal::from_str(k.get("l")?.as_str()?).ok()?;
        let close = Decimal::from_str(k.get("c")?.as_str()?).ok()?;
        let is_closed = k.get("x")?.as_bool()?;
        let event_time = frame.data.get("E").and_then(|v| v.as_i64()).unwrap_or(0);

        last_open_price.insert(symbol.clone(), open);
        let change_pct = if open > dec!(0) {
            (((close - open) / open) * dec!(100)).round_dp(4)
        } else {
            dec!(0)
        };

        return Some(MarketTick {
            symbol,
            mark_price: close,
            open_price: open,
            high_price: high,
            low_price: low,
            close_price: close,
            change_pct_24h: change_pct,
            is_kline_closed: is_closed,
            event_time_ms: event_time,
        });
    }

    if frame.stream.contains("@markPrice") {
        let symbol = frame.data.get("s")?.as_str()?.to_uppercase();
        let mark = Decimal::from_str(frame.data.get("p")?.as_str()?).ok()?;
        let event_time = frame.data.get("E").and_then(|v| v.as_i64()).unwrap_or(0);
        let open = last_open_price.get(&symbol).copied().unwrap_or(mark);
        let change_pct = if open > dec!(0) {
            (((mark - open) / open) * dec!(100)).round_dp(4)
        } else {
            dec!(0)
        };

        return Some(MarketTick {
            symbol,
            mark_price: mark,
            open_price: open,
            high_price: mark,
            low_price: mark,
            close_price: mark,
            change_pct_24h: change_pct,
            is_kline_closed: false,
            event_time_ms: event_time,
        });
    }

    None
}
