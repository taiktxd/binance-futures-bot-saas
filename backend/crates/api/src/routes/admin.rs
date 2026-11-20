use crate::auth_mw::AdminUser;
use crate::state::{ApiError, ApiResult, AppState};
use axum::{
    extract::{Path, State},
    Json,
};
use binance::BinanceFuturesClient;
use chrono::{DateTime, Utc};
use common::{
    AppError, BinanceEnv, LeverageMode, MarginMode, PositionRecord, PositionSide, UserRecord,
    WithdrawMethod, WithdrawRequestRecord, WithdrawStatus,
};
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Row};
use uuid::Uuid;

#[derive(Deserialize)]
pub struct AdminCreditAdjustRequest {
    pub amount: Decimal,
    pub note: String,
}

#[derive(Deserialize)]
pub struct ProcessWithdrawRequest {
    pub status: WithdrawStatus,
    pub admin_note: Option<String>,
}

#[derive(Deserialize)]
pub struct TestOrderRequest {
    pub side: PositionSide,
}

#[derive(Serialize, FromRow)]
pub struct AdminWithdrawItem {
    pub id: Uuid,
    pub user_id: Uuid,
    pub user_email: String,
    pub method: WithdrawMethod,
    pub amount_usd: Decimal,
    pub vnd_rate_snapshot: Option<Decimal>,
    pub amount_vnd: Option<Decimal>,
    pub bsc20_address: Option<String>,
    pub bank_name: Option<String>,
    pub bank_account_no: Option<String>,
    pub bank_account_holder: Option<String>,
    pub status: WithdrawStatus,
    pub admin_note: Option<String>,
    pub processed_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct EngineStatusResponse {
    pub ws_feed_connected: bool,
    pub active_gold_symbol: String,
    pub total_users: i64,
    pub running_bots: i64,
    pub stop_new_entries_bots: i64,
    pub open_positions: i64,
}

pub async fn list_users(
    State(state): State<AppState>,
    _admin: AdminUser,
) -> ApiResult<Json<Vec<UserRecord>>> {
    let users =
        sqlx::query_as::<_, UserRecord>("SELECT * FROM users ORDER BY created_at DESC LIMIT 200")
            .fetch_all(&state.pool)
            .await?;
    Ok(Json(users))
}

pub async fn adjust_user_credit(
    State(state): State<AppState>,
    AdminUser(admin): AdminUser,
    Path(target_user_id): Path<Uuid>,
    Json(payload): Json<AdminCreditAdjustRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    if payload.amount == dec!(0) {
        return Err(ApiError(AppError::Validation(
            "adjustment amount cannot be zero".to_string(),
        )));
    }

    let mut tx = state.pool.begin().await?;
    let row = sqlx::query("SELECT credit_balance FROM users WHERE id = $1 FOR UPDATE")
        .bind(target_user_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| AppError::NotFound("target user not found".to_string()))?;

    let before: Decimal = row.try_get("credit_balance")?;
    let after = (before + payload.amount).round_dp(8);

    sqlx::query(
        r#"
        UPDATE users
        SET credit_balance = $1,
            low_credit_alert_sent = CASE WHEN $1 >= $2 THEN FALSE ELSE low_credit_alert_sent END,
            zero_credit_alert_sent = CASE WHEN $1 > 0 THEN FALSE ELSE zero_credit_alert_sent END
        WHERE id = $3
        "#,
    )
    .bind(after)
    .bind(state.config.low_credit_alert_threshold_usd)
    .bind(target_user_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO credit_transactions (
            user_id, tx_type, amount, balance_before, balance_after, note, metadata
        )
        VALUES ($1, 'ADMIN_ADJUSTMENT', $2, $3, $4, $5, $6)
        "#,
    )
    .bind(target_user_id)
    .bind(payload.amount)
    .bind(before)
    .bind(after)
    .bind(&payload.note)
    .bind(serde_json::json!({ "admin_id": admin.user_id }))
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(Json(serde_json::json!({
        "user_id": target_user_id,
        "balance_before": before,
        "balance_after": after
    })))
}

pub async fn engine_status(
    State(state): State<AppState>,
    _admin: AdminUser,
) -> ApiResult<Json<EngineStatusResponse>> {
    let total_users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&state.pool)
        .await?;
    let running_bots: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM bot_configs WHERE status = 'RUNNING'")
            .fetch_one(&state.pool)
            .await?;
    let stop_new_entries_bots: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM bot_configs WHERE status = 'STOP_NEW_ENTRIES'")
            .fetch_one(&state.pool)
            .await?;
    let open_positions: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM positions WHERE status = 'OPEN'")
            .fetch_one(&state.pool)
            .await?;

    Ok(Json(EngineStatusResponse {
        ws_feed_connected: state
            .ws_connected
            .load(std::sync::atomic::Ordering::Relaxed),
        active_gold_symbol: state.active_gold_symbol.clone(),
        total_users,
        running_bots,
        stop_new_entries_bots,
        open_positions,
    }))
}

pub async fn list_withdrawals(
    State(state): State<AppState>,
    _admin: AdminUser,
) -> ApiResult<Json<Vec<AdminWithdrawItem>>> {
    let items = sqlx::query_as::<_, AdminWithdrawItem>(
        r#"
        SELECT w.id, w.user_id, u.email AS user_email, w.method, w.amount_usd,
               w.vnd_rate_snapshot, w.amount_vnd, w.bsc20_address, w.bank_name,
               w.bank_account_no, w.bank_account_holder, w.status, w.admin_note,
               w.processed_at, w.created_at
        FROM withdraw_requests w
        INNER JOIN users u ON u.id = w.user_id
        ORDER BY CASE WHEN w.status = 'PENDING' THEN 0 ELSE 1 END, w.created_at DESC
        LIMIT 100
        "#,
    )
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(items))
}

pub async fn process_withdrawal(
    State(state): State<AppState>,
    _admin: AdminUser,
    Path(withdraw_id): Path<Uuid>,
    Json(payload): Json<ProcessWithdrawRequest>,
) -> ApiResult<Json<WithdrawRequestRecord>> {
    if payload.status != WithdrawStatus::Approved && payload.status != WithdrawStatus::Rejected {
        return Err(ApiError(AppError::Validation(
            "status must be APPROVED or REJECTED".to_string(),
        )));
    }

    let note_clean = payload
        .admin_note
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let mut tx = state.pool.begin().await?;
    let existing = sqlx::query_as::<_, WithdrawRequestRecord>(
        "SELECT * FROM withdraw_requests WHERE id = $1 FOR UPDATE",
    )
    .bind(withdraw_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::NotFound("withdrawal request not found".to_string()))?;

    if existing.status != WithdrawStatus::Pending {
        return Err(ApiError(AppError::Conflict(
            "withdrawal request has already been processed".to_string(),
        )));
    }

    let updated = sqlx::query_as::<_, WithdrawRequestRecord>(
        r#"
        UPDATE withdraw_requests
        SET status = $1, admin_note = $2, processed_at = NOW()
        WHERE id = $3
        RETURNING *
        "#,
    )
    .bind(payload.status)
    .bind(&note_clean)
    .bind(withdraw_id)
    .fetch_one(&mut *tx)
    .await?;

    let (title, body) = match payload.status {
        WithdrawStatus::Approved => {
            let suffix = note_clean
                .as_deref()
                .map(|n| format!(" Ghi chú: {n}"))
                .unwrap_or_default();
            (
                "Đã duyệt yêu cầu rút tiền",
                format!(
                    "Yêu cầu rút ${:.2} đã được duyệt và giải ngân.{}",
                    existing.amount_usd, suffix
                ),
            )
        }
        WithdrawStatus::Rejected => {
            // Refund reserved partner commission balance atomically when rejecting a withdrawal.
            sqlx::query(
                "UPDATE users SET commission_balance = commission_balance + $1 WHERE id = $2",
            )
            .bind(existing.amount_usd)
            .bind(existing.user_id)
            .execute(&mut *tx)
            .await?;

            let suffix = note_clean
                .as_deref()
                .map(|n| format!(" Lý do: {n}"))
                .unwrap_or_default();
            (
                "Yêu cầu rút tiền bị từ chối",
                format!(
                    "Yêu cầu rút ${:.2} bị từ chối và đã hoàn lại vào số dư hoa hồng.{}",
                    existing.amount_usd, suffix
                ),
            )
        }
        WithdrawStatus::Pending => {
            return Err(ApiError(AppError::Validation(
                "status must be APPROVED or REJECTED".to_string(),
            )));
        }
    };

    sqlx::query("INSERT INTO notifications (user_id, title, body) VALUES ($1, $2, $3)")
        .bind(existing.user_id)
        .bind(title)
        .bind(body)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(Json(updated))
}

/// Executes an immediate Testnet-only bracket order (Market + SL/TP) for an admin's bot
/// so the full Binance Demo execution and reconciliation flow can be verified without waiting
/// for the 55-candle strategy warmup. Strictly forbidden outside TESTNET.
pub async fn trigger_testnet_order(
    State(state): State<AppState>,
    AdminUser(admin): AdminUser,
    Path(bot_id): Path<Uuid>,
    Json(payload): Json<TestOrderRequest>,
) -> ApiResult<Json<PositionRecord>> {
    if state.config.binance_market_feed_env != BinanceEnv::Testnet {
        return Err(ApiError(AppError::Forbidden(
            "manual test orders are strictly restricted to TESTNET".to_string(),
        )));
    }

    let mut tx = state.pool.begin().await?;
    let row = sqlx::query(
        r#"
        SELECT b.symbol, b.margin_type, b.leverage_mode, b.leverage,
               b.order_margin_usdt, b.max_open_positions, b.sl_pct, b.tp_pct,
               k.environment, k.api_key, k.api_secret_encrypted, k.encryption_nonce
        FROM bot_configs b
        INNER JOIN api_keys k ON k.id = b.api_key_id
        WHERE b.id = $1
          AND b.user_id = $2
          AND k.environment = 'TESTNET'
          AND k.is_active = TRUE
          AND k.can_trade_futures = TRUE
          AND k.can_withdraw = FALSE
        FOR UPDATE OF b
        "#,
    )
    .bind(bot_id)
    .bind(admin.user_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::NotFound("active TESTNET bot owned by admin not found".to_string()))?;

    let symbol: String = row.try_get("symbol")?;
    let margin_type: MarginMode = row.try_get("margin_type")?;
    let leverage_mode: LeverageMode = row.try_get("leverage_mode")?;
    let custom_leverage: i16 = row.try_get("leverage")?;
    let order_margin: Decimal = row.try_get("order_margin_usdt")?;
    let max_open: i16 = row.try_get("max_open_positions")?;
    let sl_pct: Decimal = row.try_get("sl_pct")?;
    let tp_pct: Decimal = row.try_get("tp_pct")?;
    let env: BinanceEnv = row.try_get("environment")?;
    let api_key: String = row.try_get("api_key")?;
    let secret_enc: String = row.try_get("api_secret_encrypted")?;
    let nonce: String = row.try_get("encryption_nonce")?;

    let Some(filter) = state.filters.get(&symbol).cloned() else {
        return Err(ApiError(AppError::Exchange(format!(
            "missing exchange filter for {symbol}"
        ))));
    };

    let locked: bool = sqlx::query_scalar(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))",
    )
    .bind(&api_key)
    .bind(&symbol)
    .fetch_one(&mut *tx)
    .await?;
    if !locked {
        return Err(ApiError(AppError::Conflict(
            "another order execution is currently in progress for this symbol".to_string(),
        )));
    }

    let open_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM positions WHERE bot_config_id = $1 AND status = 'OPEN'",
    )
    .bind(bot_id)
    .fetch_one(&mut *tx)
    .await?;
    if open_count >= i64::from(max_open) {
        return Err(ApiError(AppError::Conflict(
            "bot already has an open position; close it before placing another test order"
                .to_string(),
        )));
    }

    let secret = state.cipher.decrypt(&secret_enc, &nonce)?;
    let base_url = state.config.rest_url_for(env).to_string();
    let client = BinanceFuturesClient::authenticated(base_url, env, api_key, secret)?;

    let current_amt = client.fetch_position_amt(&symbol).await?;
    if !current_amt.is_zero() {
        return Err(ApiError(AppError::Conflict(format!(
            "exchange already has an open {symbol} position ({current_amt}); close it first"
        ))));
    }

    let target_leverage = match leverage_mode {
        LeverageMode::ExchangeMax => client
            .fetch_exchange_max_leverage(&symbol)
            .await
            .unwrap_or(custom_leverage.max(1)),
        LeverageMode::Custom => custom_leverage.max(1),
    };

    client.set_margin_type(&symbol, margin_type).await?;
    client.set_leverage(&symbol, target_leverage).await?;

    let mark_price = client.fetch_mark_price(&symbol).await?;
    let notional = order_margin * Decimal::from(target_leverage);
    let raw_qty = notional / mark_price;

    let sl_ratio = sl_pct / dec!(100);
    let tp_ratio = tp_pct / dec!(100);
    let (raw_sl, raw_tp) = match payload.side {
        PositionSide::Long => (
            mark_price * (dec!(1) - sl_ratio),
            mark_price * (dec!(1) + tp_ratio),
        ),
        PositionSide::Short => (
            mark_price * (dec!(1) + sl_ratio),
            mark_price * (dec!(1) - tp_ratio),
        ),
    };

    let opened_at = Utc::now();
    let exec = client
        .place_bracket_order(&symbol, payload.side, raw_qty, raw_sl, raw_tp, &filter)
        .await?;

    let fill_price = if exec.executed_price > dec!(0) {
        exec.executed_price
    } else {
        mark_price
    };

    let pos = sqlx::query_as::<_, PositionRecord>(
        r#"
        INSERT INTO positions (
            user_id, bot_config_id, symbol, side, margin_type, leverage,
            entry_price, quantity, stop_loss_price, take_profit_price,
            binance_entry_order_id, binance_sl_order_id, binance_tp_order_id, status, opened_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'OPEN',$14)
        RETURNING *
        "#,
    )
    .bind(admin.user_id)
    .bind(bot_id)
    .bind(&symbol)
    .bind(payload.side)
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
    .fetch_one(&mut *tx)
    .await?;

    if let Some(ref prot_err) = exec.protection_error {
        sqlx::query("UPDATE bot_configs SET last_error = $1, status = 'ERROR' WHERE id = $2")
            .bind(prot_err)
            .bind(bot_id)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;
    Ok(Json(pos))
}
