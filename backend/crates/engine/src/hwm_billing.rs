use crate::telegram::TelegramNotifier;
use common::{
    calculate_hwm_settlement, f1_hwm_commission_rate, AppError, AppResult, BinanceEnv,
    PositionSide, F2_HWM_COMMISSION_RATE,
};
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use serde_json::json;
use sqlx::{PgPool, Postgres, Row, Transaction};
use tracing::{info, warn};
use uuid::Uuid;

pub struct ClosedPositionInput {
    pub user_id: Uuid,
    pub environment: BinanceEnv,
    pub bot_config_id: Uuid,
    pub position_id: Uuid,
    pub symbol: String,
    pub side: PositionSide,
    pub entry_price: Decimal,
    pub exit_price: Decimal,
    pub quantity: Decimal,
    pub gross_pnl: Decimal,
    pub exchange_fee: Decimal,
    pub funding_fee: Decimal,
    pub realized_pnl: Decimal,
    pub close_reason: String,
    pub binance_order_id: Option<String>,
    pub binance_trade_id: Option<String>,
}

/// Settles a closed Futures position inside a single ACID transaction:
/// 1. Locks the user row (`FOR UPDATE`) to prevent concurrent HWM race conditions.
/// 2. Computes exact 20% HWM fee via `rust_decimal`.
/// 3. Records `trades` and `credit_transactions` audit rows.
/// 4. If `credit_balance <= 0`, sets all RUNNING bots to `STOP_NEW_ENTRIES` while
///    explicitly preserving any remaining open positions and their SL/TP orders.
pub async fn settle_closed_position(
    pool: &PgPool,
    notifier: &TelegramNotifier,
    fee_rate: Decimal,
    low_credit_threshold: Decimal,
    input: ClosedPositionInput,
) -> AppResult<()> {
    let mut tx = pool.begin().await?;

    let user_row = sqlx::query(
        r#"
        SELECT credit_balance, cumulative_net_pnl, high_water_mark,
               telegram_chat_id, low_credit_alert_sent, zero_credit_alert_sent,
               referred_by_user_id
        FROM users
        WHERE id = $1
        FOR UPDATE
        "#,
    )
    .bind(input.user_id)
    .fetch_one(&mut *tx)
    .await?;

    let credit_before: Decimal = user_row.try_get("credit_balance")?;
    let cumulative_before: Decimal = user_row.try_get("cumulative_net_pnl")?;
    let hwm_before: Decimal = user_row.try_get("high_water_mark")?;
    let telegram_chat_id: Option<String> = user_row.try_get("telegram_chat_id")?;
    let low_alert_sent: bool = user_row.try_get("low_credit_alert_sent")?;
    let zero_alert_sent: bool = user_row.try_get("zero_credit_alert_sent")?;
    let referred_by_user_id: Option<Uuid> = user_row.try_get("referred_by_user_id")?;

    let settlement = calculate_hwm_settlement(
        credit_before,
        cumulative_before,
        hwm_before,
        input.realized_pnl,
        if input.environment == BinanceEnv::Live {
            fee_rate
        } else {
            Decimal::ZERO
        },
    );

    sqlx::query(
        r#"
        UPDATE positions
        SET status = 'CLOSED', unrealized_pnl = 0, closed_at = NOW()
        WHERE id = $1
        "#,
    )
    .bind(input.position_id)
    .execute(&mut *tx)
    .await?;

    let trade_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO trades (
            user_id, bot_config_id, position_id, binance_order_id, binance_trade_id,
            symbol, side, entry_price, exit_price, quantity,
            gross_pnl, exchange_fee, funding_fee, realized_pnl, hwm_fee_charged, close_reason
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        RETURNING id
        "#,
    )
    .bind(input.user_id)
    .bind(input.bot_config_id)
    .bind(input.position_id)
    .bind(input.binance_order_id)
    .bind(input.binance_trade_id)
    .bind(&input.symbol)
    .bind(input.side)
    .bind(input.entry_price)
    .bind(input.exit_price)
    .bind(input.quantity)
    .bind(input.gross_pnl)
    .bind(input.exchange_fee)
    .bind(input.funding_fee)
    .bind(input.realized_pnl)
    .bind(settlement.fee_charged)
    .bind(&input.close_reason)
    .fetch_one(&mut *tx)
    .await?;

    if input.environment == BinanceEnv::Testnet {
        tx.commit().await?;
        return Ok(());
    }

    if settlement.fee_charged > dec!(0) {
        sqlx::query(
            r#"
            INSERT INTO credit_transactions (
                user_id, tx_type, amount, balance_before, balance_after,
                cumulative_pnl_after, hwm_before, hwm_after, reference_trade_id, note, metadata
            )
            VALUES ($1, 'HWM_FEE_DEDUCTION', $2, $3, $4, $5, $6, $7, $8, $9, $10)
            "#,
        )
        .bind(input.user_id)
        .bind(-settlement.fee_charged)
        .bind(credit_before)
        .bind(settlement.credit_balance_after)
        .bind(settlement.cumulative_net_pnl_after)
        .bind(settlement.hwm_before)
        .bind(settlement.hwm_after)
        .bind(trade_id)
        .bind(format!(
            "20% HWM fee on {} excess profit {} USDT",
            input.symbol, settlement.profit_above_hwm
        ))
        .bind(json!({
            "symbol": input.symbol,
            "realized_pnl": input.realized_pnl.to_string(),
            "profit_above_hwm": settlement.profit_above_hwm.to_string()
        }))
        .execute(&mut *tx)
        .await?;

        credit_hwm_partner_commissions(
            &mut tx,
            input.user_id,
            referred_by_user_id,
            &input.symbol,
            settlement.fee_charged,
        )
        .await?;
    }

    let trigger_zero_alert = settlement.should_stop_new_entries && !zero_alert_sent;
    let trigger_low_alert = !settlement.should_stop_new_entries
        && settlement.credit_balance_after < low_credit_threshold
        && !low_alert_sent;

    sqlx::query(
        r#"
        UPDATE users
        SET credit_balance = $1,
            cumulative_net_pnl = $2,
            high_water_mark = $3,
            low_credit_alert_sent = CASE WHEN $4 THEN TRUE ELSE low_credit_alert_sent END,
            zero_credit_alert_sent = CASE WHEN $5 THEN TRUE ELSE zero_credit_alert_sent END
        WHERE id = $6
        "#,
    )
    .bind(settlement.credit_balance_after)
    .bind(settlement.cumulative_net_pnl_after)
    .bind(settlement.hwm_after)
    .bind(trigger_low_alert)
    .bind(trigger_zero_alert)
    .bind(input.user_id)
    .execute(&mut *tx)
    .await?;

    // Safety invariant: Never force-close open positions when credit <= 0.
    // Only block new entries by transitioning RUNNING bots to STOP_NEW_ENTRIES.
    if settlement.should_stop_new_entries {
        sqlx::query(
            r#"
            UPDATE bot_configs
            SET status = 'STOP_NEW_ENTRIES'
            WHERE user_id = $1 AND status = 'RUNNING'
              AND api_key_id IN (SELECT id FROM api_keys WHERE environment = 'LIVE')
            "#,
        )
        .bind(input.user_id)
        .execute(&mut *tx)
        .await?;

        warn!(
            user_id = %input.user_id,
            credit_after = %settlement.credit_balance_after,
            "credit depleted; switched running bots to STOP_NEW_ENTRIES without closing open positions"
        );
    }

    tx.commit().await.map_err(AppError::Database)?;

    info!(
        user_id = %input.user_id,
        symbol = %input.symbol,
        realized_pnl = %input.realized_pnl,
        hwm_fee = %settlement.fee_charged,
        credit_after = %settlement.credit_balance_after,
        "settled closed position"
    );

    if trigger_zero_alert {
        let msg = format!(
            "<b>[CANH BAO CREDIT = 0]</b>\nSo du Credit hien tai: <b>${:.2}</b>.\nHe thong da chuyen bot sang trang thai <code>STOP_NEW_ENTRIES</code> (khong mo lenh moi). Cac vi the dang mo van duoc giu nguyen quan ly TP/SL. Vui long nap Credit de tiep tuc giao dich.",
            settlement.credit_balance_after
        );
        notifier
            .notify_user(
                pool,
                input.user_id,
                telegram_chat_id.as_deref(),
                "ZERO_CREDIT_STOP_NEW_ENTRIES",
                &msg,
            )
            .await;
    } else if trigger_low_alert {
        let msg = format!(
            "<b>[CANH BAO CREDIT THAP]</b>\nSo du Credit hien tai: <b>${:.2}</b> (duoi nguong ${:.2}). Vui long nap them Credit de bot khong bi tam ngung mo lenh moi.",
            settlement.credit_balance_after, low_credit_threshold
        );
        notifier
            .notify_user(
                pool,
                input.user_id,
                telegram_chat_id.as_deref(),
                "LOW_CREDIT_WARNING",
                &msg,
            )
            .await;
    }

    Ok(())
}

/// Credits 2-tier partner commissions inside the same HWM settlement transaction:
/// F1 receives 15%-30% of the HWM fee based on activated F1 count; F2 receives 5%.
async fn credit_hwm_partner_commissions(
    tx: &mut Transaction<'_, Postgres>,
    trader_user_id: Uuid,
    f1_referrer_id: Option<Uuid>,
    symbol: &str,
    hwm_fee_charged: Decimal,
) -> AppResult<()> {
    let Some(f1_id) = f1_referrer_id.filter(|id| *id != trader_user_id) else {
        return Ok(());
    };

    let f1_row = sqlx::query("SELECT referred_by_user_id FROM users WHERE id = $1 FOR UPDATE")
        .bind(f1_id)
        .fetch_optional(&mut **tx)
        .await?;
    let Some(f1_row) = f1_row else {
        return Ok(());
    };
    let f2_referrer_id: Option<Uuid> = f1_row.try_get("referred_by_user_id")?;

    let active_f1_count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*) FROM users
        WHERE referred_by_user_id = $1
          AND is_active = TRUE
          AND (bonus_credit_granted = TRUE OR plan <> 'INACTIVE')
        "#,
    )
    .bind(f1_id)
    .fetch_one(&mut **tx)
    .await?;

    let f1_rate = f1_hwm_commission_rate(active_f1_count);
    let f1_commission = (hwm_fee_charged * f1_rate).round_dp(8);
    if f1_commission > dec!(0) {
        sqlx::query("UPDATE users SET commission_balance = commission_balance + $1 WHERE id = $2")
            .bind(f1_commission)
            .bind(f1_id)
            .execute(&mut **tx)
            .await?;

        let rate_pct = (f1_rate * dec!(100)).round_dp(0);
        sqlx::query("INSERT INTO notifications (user_id, title, body) VALUES ($1, $2, $3)")
            .bind(f1_id)
            .bind("Hoa hồng đối tác F1")
            .bind(format!(
                "Bạn nhận được ${:.4} hoa hồng F1 ({}% phí HWM từ lệnh {}).",
                f1_commission, rate_pct, symbol
            ))
            .execute(&mut **tx)
            .await?;
    }

    if let Some(f2_id) = f2_referrer_id.filter(|id| *id != f1_id && *id != trader_user_id) {
        let f2_commission = (hwm_fee_charged * F2_HWM_COMMISSION_RATE).round_dp(8);
        if f2_commission > dec!(0) {
            let updated = sqlx::query(
                "UPDATE users SET commission_balance = commission_balance + $1 WHERE id = $2",
            )
            .bind(f2_commission)
            .bind(f2_id)
            .execute(&mut **tx)
            .await?
            .rows_affected();

            if updated > 0 {
                sqlx::query("INSERT INTO notifications (user_id, title, body) VALUES ($1, $2, $3)")
                    .bind(f2_id)
                    .bind("Hoa hồng hệ thống F2")
                    .bind(format!(
                        "Bạn nhận được ${:.4} hoa hồng F2 (5% phí HWM từ nhánh đối tác trên cặp {}).",
                        f2_commission, symbol
                    ))
                    .execute(&mut **tx)
                    .await?;
            }
        }
    }

    Ok(())
}
