use crate::auth_mw::AuthUser;
use crate::state::{ApiError, ApiResult, AppState};
use axum::{
    extract::{Path, Query, State},
    Json,
};
use common::{
    AllowedSymbol, AppError, BinanceEnv, BotConfigRecord, LeverageMode, MarginMode, PositionRecord,
    RiskProfile, TradeRecord, UserRecord, UserRole,
};
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Deserialize)]
pub struct CreateBotRequest {
    pub api_key_id: Uuid,
    pub symbol: String,
    pub risk_profile: RiskProfile,
    pub margin_type: MarginMode,
    pub leverage_mode: LeverageMode,
    pub leverage: i16,
    pub order_margin_usdt: Decimal,
    pub max_open_positions: Option<i16>,
    pub sl_pct: Option<Decimal>,
    pub tp_pct: Option<Decimal>,
    pub enable_breakeven: Option<bool>,
}

#[derive(Deserialize)]
pub struct UpdateBotRequest {
    pub risk_profile: Option<RiskProfile>,
    pub margin_type: Option<MarginMode>,
    pub leverage_mode: Option<LeverageMode>,
    pub leverage: Option<i16>,
    pub order_margin_usdt: Option<Decimal>,
    pub sl_pct: Option<Decimal>,
    pub tp_pct: Option<Decimal>,
    pub enable_breakeven: Option<bool>,
}

#[derive(Serialize)]
pub struct DashboardSummaryResponse {
    pub credit_balance: Decimal,
    pub cumulative_net_pnl: Decimal,
    pub high_water_mark: Decimal,
    pub active_bots_count: i64,
    pub open_positions: Vec<PositionRecord>,
    pub active_gold_symbol: String,
    pub ws_feed_connected: bool,
}

#[derive(Deserialize)]
pub struct TradeFilterQuery {
    pub symbol: Option<String>,
    pub limit: Option<i64>,
}

pub async fn list_bots(
    State(state): State<AppState>,
    auth: AuthUser,
) -> ApiResult<Json<Vec<BotConfigRecord>>> {
    let bots = sqlx::query_as::<_, BotConfigRecord>(
        "SELECT * FROM bot_configs WHERE user_id = $1 ORDER BY created_at DESC",
    )
    .bind(auth.user_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(bots))
}

pub async fn create_bot(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(payload): Json<CreateBotRequest>,
) -> ApiResult<Json<BotConfigRecord>> {
    let symbol = AllowedSymbol::parse(&payload.symbol)?;
    if payload.leverage < 1 {
        return Err(ApiError(AppError::Validation(
            "leverage must be at least 1x".to_string(),
        )));
    }
    if payload.order_margin_usdt <= dec!(0) {
        return Err(ApiError(AppError::Validation(
            "order_margin_usdt must be greater than 0".to_string(),
        )));
    }

    let key_exists: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM api_keys WHERE id = $1 AND user_id = $2")
            .bind(payload.api_key_id)
            .bind(auth.user_id)
            .fetch_one(&state.pool)
            .await?;
    if key_exists == 0 {
        return Err(ApiError(AppError::NotFound(
            "referenced API key not found".to_string(),
        )));
    }

    let sl = payload.sl_pct.unwrap_or(dec!(1.5));
    let tp = payload.tp_pct.unwrap_or(dec!(3.5));
    if sl <= dec!(0) || tp <= dec!(0) {
        return Err(ApiError(AppError::Validation(
            "SL and TP percentages must be positive".to_string(),
        )));
    }

    let bot = sqlx::query_as::<_, BotConfigRecord>(
        r#"
        INSERT INTO bot_configs (
            user_id, api_key_id, symbol, risk_profile, margin_type,
            leverage_mode, leverage, order_margin_usdt, max_open_positions,
            sl_pct, tp_pct, enable_breakeven
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING *
        "#,
    )
    .bind(auth.user_id)
    .bind(payload.api_key_id)
    .bind(symbol.as_str())
    .bind(payload.risk_profile)
    .bind(payload.margin_type)
    .bind(payload.leverage_mode)
    .bind(payload.leverage)
    .bind(payload.order_margin_usdt)
    .bind(payload.max_open_positions.unwrap_or(1).max(1))
    .bind(sl)
    .bind(tp)
    .bind(payload.enable_breakeven.unwrap_or(true))
    .fetch_one(&state.pool)
    .await?;

    Ok(Json(bot))
}

pub async fn update_bot(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
    Json(payload): Json<UpdateBotRequest>,
) -> ApiResult<Json<BotConfigRecord>> {
    if let Some(lev) = payload.leverage {
        if lev < 1 {
            return Err(ApiError(AppError::Validation(
                "leverage must be at least 1x".to_string(),
            )));
        }
    }

    let updated = sqlx::query_as::<_, BotConfigRecord>(
        r#"
        UPDATE bot_configs
        SET risk_profile = COALESCE($1, risk_profile),
            margin_type = COALESCE($2, margin_type),
            leverage_mode = COALESCE($3, leverage_mode),
            leverage = COALESCE($4, leverage),
            order_margin_usdt = COALESCE($5, order_margin_usdt),
            sl_pct = COALESCE($6, sl_pct),
            tp_pct = COALESCE($7, tp_pct),
            enable_breakeven = COALESCE($8, enable_breakeven)
        WHERE id = $9 AND user_id = $10
        RETURNING *
        "#,
    )
    .bind(payload.risk_profile)
    .bind(payload.margin_type)
    .bind(payload.leverage_mode)
    .bind(payload.leverage)
    .bind(payload.order_margin_usdt)
    .bind(payload.sl_pct)
    .bind(payload.tp_pct)
    .bind(payload.enable_breakeven)
    .bind(id)
    .bind(auth.user_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("bot configuration not found".to_string()))?;

    Ok(Json(updated))
}

pub async fn start_bot(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<BotConfigRecord>> {
    let (environment, credit): (BinanceEnv, Decimal) = sqlx::query_as(
        "SELECT k.environment, u.credit_balance FROM bot_configs b
         JOIN api_keys k ON k.id = b.api_key_id
         JOIN users u ON u.id = b.user_id
         WHERE b.id = $1 AND b.user_id = $2 AND k.is_active AND k.can_trade_futures",
    )
    .bind(id)
    .bind(auth.user_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("bot or active trading key not found".to_string()))?;

    if environment != state.config.binance_market_feed_env
        || (environment == BinanceEnv::Live && !state.config.enable_live_trading)
        || (environment == BinanceEnv::Testnet && auth.role != UserRole::Admin)
    {
        return Err(AppError::Forbidden("trading environment is unavailable".to_string()).into());
    }
    if environment == BinanceEnv::Live && credit <= dec!(0) {
        return Err(AppError::Forbidden("insufficient credit balance".to_string()).into());
    }

    let bot = sqlx::query_as::<_, BotConfigRecord>(
        r#"
        UPDATE bot_configs
        SET status = 'RUNNING', last_error = NULL
        WHERE id = $1 AND user_id = $2
        RETURNING *
        "#,
    )
    .bind(id)
    .bind(auth.user_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("bot configuration not found".to_string()))?;

    Ok(Json(bot))
}

pub async fn stop_bot(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<BotConfigRecord>> {
    let bot = sqlx::query_as::<_, BotConfigRecord>(
        r#"
        UPDATE bot_configs
        SET status = 'STOPPED'
        WHERE id = $1 AND user_id = $2
        RETURNING *
        "#,
    )
    .bind(id)
    .bind(auth.user_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("bot configuration not found".to_string()))?;

    Ok(Json(bot))
}

pub async fn dashboard_summary(
    State(state): State<AppState>,
    auth: AuthUser,
) -> ApiResult<Json<DashboardSummaryResponse>> {
    let user = sqlx::query_as::<_, UserRecord>("SELECT * FROM users WHERE id = $1")
        .bind(auth.user_id)
        .fetch_one(&state.pool)
        .await?;

    let active_bots_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM bot_configs WHERE user_id = $1 AND status = 'RUNNING'",
    )
    .bind(auth.user_id)
    .fetch_one(&state.pool)
    .await?;

    let open_positions = sqlx::query_as::<_, PositionRecord>(
        "SELECT * FROM positions WHERE user_id = $1 AND status = 'OPEN' ORDER BY opened_at DESC",
    )
    .bind(auth.user_id)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(DashboardSummaryResponse {
        credit_balance: user.credit_balance,
        cumulative_net_pnl: user.cumulative_net_pnl,
        high_water_mark: user.high_water_mark,
        active_bots_count,
        open_positions,
        active_gold_symbol: state.active_gold_symbol.clone(),
        ws_feed_connected: state
            .ws_connected
            .load(std::sync::atomic::Ordering::Relaxed),
    }))
}

pub async fn list_positions(
    State(state): State<AppState>,
    auth: AuthUser,
) -> ApiResult<Json<Vec<PositionRecord>>> {
    let items = sqlx::query_as::<_, PositionRecord>(
        "SELECT * FROM positions WHERE user_id = $1 AND status = 'OPEN' ORDER BY opened_at DESC",
    )
    .bind(auth.user_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(items))
}

pub async fn list_trades(
    State(state): State<AppState>,
    auth: AuthUser,
    Query(filter): Query<TradeFilterQuery>,
) -> ApiResult<Json<Vec<TradeRecord>>> {
    let limit = filter.limit.unwrap_or(50).clamp(1, 200);
    let items = match filter.symbol.filter(|s| !s.trim().is_empty()) {
        Some(sym) => {
            sqlx::query_as::<_, TradeRecord>(
                "SELECT * FROM trades WHERE user_id = $1 AND symbol = $2 ORDER BY executed_at DESC LIMIT $3",
            )
            .bind(auth.user_id)
            .bind(sym.to_uppercase())
            .bind(limit)
            .fetch_all(&state.pool)
            .await?
        }
        None => {
            sqlx::query_as::<_, TradeRecord>(
                "SELECT * FROM trades WHERE user_id = $1 ORDER BY executed_at DESC LIMIT $2",
            )
            .bind(auth.user_id)
            .bind(limit)
            .fetch_all(&state.pool)
            .await?
        }
    };
    Ok(Json(items))
}
