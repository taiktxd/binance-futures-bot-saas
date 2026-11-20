use crate::hwm_billing::{settle_closed_position, ClosedPositionInput};
use crate::strategy::{ExtremeAdaptiveCore, ExtremeSignal};
use crate::telegram::TelegramNotifier;
use binance::{BinanceFuturesClient, SymbolFilter};
use chrono::{DateTime, Utc};
use common::{
    Aes256GcmCipher, AppConfig, BinanceEnv, LeverageMode, MarginMode, MarketTick, PositionSide,
    RiskProfile,
};
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use sqlx::{PgPool, Row};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, RwLock, Semaphore};
use tokio::time::interval;
use tracing::{error, info, warn};
use uuid::Uuid;

const MAX_CONCURRENT_EXECUTIONS: usize = 16;

pub fn spawn_trading_engine(
    pool: PgPool,
    config: Arc<AppConfig>,
    cipher: Arc<Aes256GcmCipher>,
    notifier: Arc<TelegramNotifier>,
    filters: Arc<HashMap<String, SymbolFilter>>,
    mut market_rx: broadcast::Receiver<MarketTick>,
) {
    let latest_prices: Arc<RwLock<HashMap<String, Decimal>>> =
        Arc::new(RwLock::new(HashMap::new()));
    let exec_semaphore = Arc::new(Semaphore::new(MAX_CONCURRENT_EXECUTIONS));

    // Task 1: Hot-path Market Stream -> ExtremeAdaptiveCore -> Multi-User Execution Fan-out
    let exec_pool = pool.clone();
    let exec_config = Arc::clone(&config);
    let exec_cipher = Arc::clone(&cipher);
    let exec_filters = Arc::clone(&filters);
    let price_writer = Arc::clone(&latest_prices);
    let sem_clone = Arc::clone(&exec_semaphore);

    tokio::spawn(async move {
        let mut strategy = ExtremeAdaptiveCore::new();
        info!("EXTREME adaptive core trading engine started");

        loop {
            match market_rx.recv().await {
                Ok(tick) => {
                    {
                        let mut map = price_writer.write().await;
                        map.insert(tick.symbol.clone(), tick.mark_price);
                    }
                    if let Some(signal) = strategy.on_closed_kline(&tick) {
                        info!(
                            symbol = %signal.symbol,
                            side = ?signal.side,
                            score = signal.confluence_score,
                            regime = ?signal.regime,
                            "high-conviction signal generated"
                        );
                        dispatch_signal_to_users(
                            exec_pool.clone(),
                            Arc::clone(&exec_config),
                            Arc::clone(&exec_cipher),
                            Arc::clone(&exec_filters),
                            Arc::clone(&sem_clone),
                            signal,
                        )
                        .await;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    warn!(
                        skipped = skipped,
                        "strategy engine lagged behind market feed"
                    );
                }
                Err(broadcast::error::RecvError::Closed) => {
                    error!("market feed channel closed; stopping trading engine");
                    break;
                }
            }
        }
    });

    // Task 2: Active Position Manager (Breakeven Stop-Loss + Exact /fapi/v1/userTrades HWM Settlement)
    tokio::spawn(async move {
        let mut ticker = interval(Duration::from_secs(12));
        loop {
            ticker.tick().await;
            let price_snapshot = {
                let guard = latest_prices.read().await;
                guard.clone()
            };
            if let Err(err) = manage_and_reconcile_positions(
                &pool,
                &config,
                &cipher,
                &notifier,
                &filters,
                &price_snapshot,
            )
            .await
            {
                warn!(error = %err, "position management cycle encountered error");
            }
        }
    });
}

async fn dispatch_signal_to_users(
    pool: PgPool,
    config: Arc<AppConfig>,
    cipher: Arc<Aes256GcmCipher>,
    filters: Arc<HashMap<String, SymbolFilter>>,
    semaphore: Arc<Semaphore>,
    signal: ExtremeSignal,
) {
    let Some(filter) = filters.get(&signal.symbol).cloned() else {
        warn!(symbol = %signal.symbol, "missing exchange filter; skipping signal");
        return;
    };

    let rows = match sqlx::query(
        r#"
        SELECT b.id AS bot_id, b.user_id, b.risk_profile, b.margin_type,
               b.leverage_mode, b.leverage, b.order_margin_usdt, b.max_open_positions,
               b.sl_pct, b.tp_pct,
               k.environment, k.api_key, k.api_secret_encrypted, k.encryption_nonce
        FROM bot_configs b
        INNER JOIN users u ON u.id = b.user_id
        INNER JOIN api_keys k ON k.id = b.api_key_id
        WHERE b.symbol = $1
          AND b.status = 'RUNNING'
          AND u.is_active = TRUE
          AND k.environment = $2
          AND ((k.environment = 'TESTNET' AND u.role = 'ADMIN')
               OR (k.environment = 'LIVE' AND $3 AND u.credit_balance > 0))
          AND k.is_active = TRUE
          AND k.can_withdraw = FALSE
          AND k.can_trade_futures = TRUE
        "#,
    )
    .bind(&signal.symbol)
    .bind(config.binance_market_feed_env)
    .bind(config.enable_live_trading)
    .fetch_all(&pool)
    .await
    {
        Ok(r) => r,
        Err(err) => {
            error!(error = %err, symbol = %signal.symbol, "failed querying eligible bots");
            return;
        }
    };

    for row in rows {
        let Ok(risk_profile) = row.try_get::<RiskProfile, _>("risk_profile") else {
            continue;
        };
        if !signal.qualifies_for(risk_profile) {
            continue;
        }

        let Ok(bot_id) = row.try_get::<Uuid, _>("bot_id") else {
            continue;
        };
        let Ok(user_id) = row.try_get::<Uuid, _>("user_id") else {
            continue;
        };
        let Ok(margin_type) = row.try_get::<MarginMode, _>("margin_type") else {
            continue;
        };
        let Ok(leverage_mode) = row.try_get::<LeverageMode, _>("leverage_mode") else {
            continue;
        };
        let Ok(custom_leverage) = row.try_get::<i16, _>("leverage") else {
            continue;
        };
        let Ok(order_margin) = row.try_get::<Decimal, _>("order_margin_usdt") else {
            continue;
        };
        let Ok(max_open) = row.try_get::<i16, _>("max_open_positions") else {
            continue;
        };
        let Ok(sl_pct) = row.try_get::<Decimal, _>("sl_pct") else {
            continue;
        };
        let Ok(tp_pct) = row.try_get::<Decimal, _>("tp_pct") else {
            continue;
        };
        let Ok(env) = row.try_get::<BinanceEnv, _>("environment") else {
            continue;
        };
        let Ok(api_key) = row.try_get::<String, _>("api_key") else {
            continue;
        };
        let Ok(secret_enc) = row.try_get::<String, _>("api_secret_encrypted") else {
            continue;
        };
        let Ok(nonce) = row.try_get::<String, _>("encryption_nonce") else {
            continue;
        };

        let task_pool = pool.clone();
        let task_config = Arc::clone(&config);
        let task_cipher = Arc::clone(&cipher);
        let task_filter = filter.clone();
        let task_sig = signal.clone();
        let task_sem = Arc::clone(&semaphore);

        tokio::spawn(async move {
            let Ok(_permit) = task_sem.acquire().await else {
                return;
            };

            let Ok(mut tx) = task_pool.begin().await else {
                return;
            };
            let Ok(locked) = sqlx::query_scalar::<_, bool>(
                "SELECT pg_try_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))",
            )
            .bind(&api_key)
            .bind(&task_sig.symbol)
            .fetch_one(&mut *tx)
            .await
            else {
                return;
            };
            if !locked {
                return;
            }
            let running = sqlx::query_scalar::<_, Uuid>(
                "SELECT id FROM bot_configs WHERE id = $1 AND status = 'RUNNING' FOR UPDATE",
            )
            .bind(bot_id)
            .fetch_optional(&mut *tx)
            .await;
            if !matches!(running, Ok(Some(_))) {
                return;
            }
            let open_count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM positions WHERE bot_config_id = $1 AND status = 'OPEN'",
            )
            .bind(bot_id)
            .fetch_one(&mut *tx)
            .await
            .unwrap_or(i64::from(max_open));

            if open_count >= i64::from(max_open) {
                return;
            }

            let Ok(secret) = task_cipher.decrypt(&secret_enc, &nonce) else {
                error!(bot_id = %bot_id, "failed decrypting api secret");
                return;
            };

            let base_url = task_config.rest_url_for(env).to_string();
            let Ok(client) = BinanceFuturesClient::authenticated(base_url, env, api_key, secret)
            else {
                return;
            };

            match client.fetch_position_amt(&task_sig.symbol).await {
                Ok(amount) if amount.is_zero() => {}
                Ok(_) => return,
                Err(err) => {
                    warn!(bot_id = %bot_id, error = %err, "unable to verify flat exchange position");
                    return;
                }
            }

            // Resolve exchange-native maximum leverage when user selected EXCHANGE_MAX.
            let target_leverage = match leverage_mode {
                LeverageMode::ExchangeMax => client
                    .fetch_exchange_max_leverage(&task_sig.symbol)
                    .await
                    .unwrap_or(custom_leverage.max(1)),
                LeverageMode::Custom => custom_leverage.max(1),
            };

            if let Err(err) = client.set_margin_type(&task_sig.symbol, margin_type).await {
                warn!(bot_id = %bot_id, error = %err, "set_margin_type failed");
                return;
            }
            if let Err(err) = client.set_leverage(&task_sig.symbol, target_leverage).await {
                warn!(bot_id = %bot_id, leverage = target_leverage, error = %err, "set_leverage failed");
                return;
            }

            if task_sig.entry_price <= dec!(0) {
                return;
            }

            let notional = order_margin * Decimal::from(target_leverage);
            let raw_qty = notional / task_sig.entry_price;

            let sl_ratio = sl_pct / dec!(100);
            let tp_ratio = tp_pct / dec!(100);
            let (raw_sl, raw_tp) = match task_sig.side {
                PositionSide::Long => (
                    task_sig.entry_price * (dec!(1) - sl_ratio),
                    task_sig.entry_price * (dec!(1) + tp_ratio),
                ),
                PositionSide::Short => (
                    task_sig.entry_price * (dec!(1) + sl_ratio),
                    task_sig.entry_price * (dec!(1) - tp_ratio),
                ),
            };

            let opened_at = chrono::Utc::now();
            let failure = match client
                .place_bracket_order(
                    &task_sig.symbol,
                    task_sig.side,
                    raw_qty,
                    raw_sl,
                    raw_tp,
                    &task_filter,
                )
                .await
            {
                Ok(exec) => {
                    let fill_price = if exec.executed_price > dec!(0) {
                        exec.executed_price
                    } else {
                        task_sig.entry_price
                    };

                    let persisted = sqlx::query(
                        r#"
                        INSERT INTO positions (
                            user_id, bot_config_id, symbol, side, margin_type, leverage,
                            entry_price, quantity, stop_loss_price, take_profit_price,
                            binance_entry_order_id, binance_sl_order_id, binance_tp_order_id, status, opened_at
                        )
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'OPEN',$14)
                        "#,
                    )
                    .bind(user_id)
                    .bind(bot_id)
                    .bind(&task_sig.symbol)
                    .bind(task_sig.side)
                    .bind(margin_type)
                    .bind(target_leverage)
                    .bind(fill_price)
                    .bind(exec.executed_qty)
                    .bind(exec.stop_loss_price)
                    .bind(exec.take_profit_price)
                    .bind(exec.entry_order_id)
                    .bind(exec.sl_order_id)
                    .bind(exec.tp_order_id)
                    .bind(opened_at)
                    .execute(&mut *tx)
                    .await;
                    if let Err(err) = persisted {
                        error!(bot_id = %bot_id, error = %err, "exchange entry could not be persisted");
                        return;
                    }
                    exec.protection_error
                }
                Err(err) => Some(err.to_string()),
            };
            if let Some(message) = failure {
                warn!(bot_id = %bot_id, error = %message, "bracket execution failed");
                if let Err(err) = sqlx::query(
                    "UPDATE bot_configs SET last_error = $1, status = 'ERROR' WHERE id = $2",
                )
                .bind(message)
                .bind(bot_id)
                .execute(&mut *tx)
                .await
                {
                    error!(bot_id = %bot_id, error = %err, "could not persist bracket status");
                    return;
                }
            }
            if let Err(err) = tx.commit().await {
                error!(bot_id = %bot_id, error = %err, "could not commit bracket state");
            }
        });
    }
}

async fn manage_and_reconcile_positions(
    pool: &PgPool,
    config: &AppConfig,
    cipher: &Aes256GcmCipher,
    notifier: &TelegramNotifier,
    filters: &HashMap<String, SymbolFilter>,
    latest_prices: &HashMap<String, Decimal>,
) -> Result<(), sqlx::Error> {
    let rows = sqlx::query(
        r#"
        SELECT p.id AS pos_id, p.user_id, p.bot_config_id, p.symbol, p.side,
               p.entry_price, p.quantity, p.stop_loss_price, p.take_profit_price,
               p.breakeven_moved, p.binance_entry_order_id, p.binance_sl_order_id, p.binance_tp_order_id, p.opened_at,
               b.enable_breakeven,
               k.environment, k.api_key, k.api_secret_encrypted, k.encryption_nonce
        FROM positions p
        INNER JOIN bot_configs b ON b.id = p.bot_config_id
        INNER JOIN api_keys k ON k.id = b.api_key_id
        WHERE p.status = 'OPEN'
        "#,
    )
    .fetch_all(pool)
    .await?;

    for row in rows {
        let Ok(pos_id) = row.try_get::<Uuid, _>("pos_id") else {
            continue;
        };
        let Ok(user_id) = row.try_get::<Uuid, _>("user_id") else {
            continue;
        };
        let Ok(bot_id) = row.try_get::<Uuid, _>("bot_config_id") else {
            continue;
        };
        let Ok(symbol) = row.try_get::<String, _>("symbol") else {
            continue;
        };
        let Ok(side) = row.try_get::<PositionSide, _>("side") else {
            continue;
        };
        let Ok(entry_price) = row.try_get::<Decimal, _>("entry_price") else {
            continue;
        };
        let Ok(quantity) = row.try_get::<Decimal, _>("quantity") else {
            continue;
        };
        let Ok(tp_price) = row.try_get::<Decimal, _>("take_profit_price") else {
            continue;
        };
        let Ok(breakeven_moved) = row.try_get::<bool, _>("breakeven_moved") else {
            continue;
        };
        let Ok(enable_breakeven) = row.try_get::<bool, _>("enable_breakeven") else {
            continue;
        };
        let Ok(opened_at) = row.try_get::<DateTime<Utc>, _>("opened_at") else {
            continue;
        };
        let Ok(env) = row.try_get::<BinanceEnv, _>("environment") else {
            continue;
        };
        let Ok(api_key) = row.try_get::<String, _>("api_key") else {
            continue;
        };
        let Ok(secret_enc) = row.try_get::<String, _>("api_secret_encrypted") else {
            continue;
        };
        let Ok(nonce) = row.try_get::<String, _>("encryption_nonce") else {
            continue;
        };
        let entry_order_id: Option<String> = row.try_get("binance_entry_order_id").ok();
        let tp_id: Option<String> = row.try_get("binance_tp_order_id").ok();
        let sl_order_id: Option<String> = row.try_get("binance_sl_order_id").ok();

        let Ok(secret) = cipher.decrypt(&secret_enc, &nonce) else {
            continue;
        };
        let base_url = config.rest_url_for(env).to_string();
        let Ok(client) = BinanceFuturesClient::authenticated(base_url, env, api_key, secret) else {
            continue;
        };

        let Ok(pos_amt) = client.fetch_position_amt(&symbol).await else {
            continue;
        };

        // Active position still open: update unrealized PnL and move SL to breakeven at >= 50% TP progress.
        if pos_amt != dec!(0) {
            if let Some(&mark) = latest_prices.get(&symbol) {
                let upnl = match side {
                    PositionSide::Long => (mark - entry_price) * quantity,
                    PositionSide::Short => (entry_price - mark) * quantity,
                }
                .round_dp(8);

                let _ = sqlx::query("UPDATE positions SET unrealized_pnl = $1 WHERE id = $2")
                    .bind(upnl)
                    .bind(pos_id)
                    .execute(pool)
                    .await;

                if enable_breakeven && !breakeven_moved {
                    let halfway = match side {
                        PositionSide::Long => {
                            mark >= entry_price + (tp_price - entry_price) * dec!(0.5)
                        }
                        PositionSide::Short => {
                            mark <= entry_price - (entry_price - tp_price) * dec!(0.5)
                        }
                    };
                    if halfway {
                        if let Some(filter) = filters.get(&symbol) {
                            if let Ok(new_sl_id) = client
                                .move_stop_loss(
                                    &symbol,
                                    side,
                                    sl_order_id.as_deref(),
                                    entry_price,
                                    filter,
                                )
                                .await
                            {
                                let _ = sqlx::query(
                                    "UPDATE positions SET breakeven_moved = TRUE, stop_loss_price = $1, binance_sl_order_id = $2 WHERE id = $3",
                                )
                                .bind(entry_price)
                                .bind(new_sl_id)
                                .bind(pos_id)
                                .execute(pool)
                                .await;
                                info!(pos_id = %pos_id, symbol = %symbol, "moved stop loss to breakeven");
                            }
                        }
                    }
                }
            }
            continue;
        }

        let Some(entry_id) = entry_order_id.as_deref() else {
            continue;
        };
        let mut cleanup_ok = true;
        for id in [sl_order_id.as_deref(), tp_id.as_deref()]
            .into_iter()
            .flatten()
        {
            if let Err(err) = client.cancel_close_trigger(&symbol, id).await {
                warn!(position_id = %pos_id, error = %err, "protective order cleanup failed");
                cleanup_ok = false;
            }
        }
        if !cleanup_ok {
            continue;
        }
        let fill = match client
            .fetch_realized_fills(&symbol, opened_at.timestamp_millis(), entry_id, side)
            .await
        {
            Ok(Some(fill)) => fill,
            Ok(None) => continue,
            Err(err) => {
                warn!(position_id = %pos_id, error = %err, "exchange fills could not be reconciled");
                continue;
            }
        };
        if let Err(err) = settle_closed_position(
            pool,
            notifier,
            config.profit_sharing_fee_rate,
            config.low_credit_alert_threshold_usd,
            ClosedPositionInput {
                user_id,
                environment: env,
                bot_config_id: bot_id,
                position_id: pos_id,
                symbol,
                side,
                entry_price,
                exit_price: fill.exit_price,
                quantity,
                gross_pnl: fill.realized_pnl,
                exchange_fee: fill.commission,
                funding_fee: dec!(0),
                realized_pnl: (fill.realized_pnl - fill.commission).round_dp(8),
                close_reason: "EXCHANGE_TP_SL".to_string(),
                binance_order_id: entry_order_id,
                binance_trade_id: Some(fill.trade_id),
            },
        )
        .await
        {
            warn!(position_id = %pos_id, error = %err, "could not persist exchange settlement");
        }
    }

    Ok(())
}
