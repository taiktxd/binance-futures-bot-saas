use crate::auth_mw::AuthUser;
use crate::state::{ApiError, ApiResult, AppState};
use axum::{
    extract::{Path, State},
    Json,
};
use binance::BinanceFuturesClient;
use common::{ApiKeyRecord, AppError, BinanceEnv, UserRole};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Serialize)]
pub struct ApiKeysListResponse {
    pub server_static_ip: String,
    pub items: Vec<MaskedApiKey>,
}

#[derive(Serialize)]
pub struct MaskedApiKey {
    pub id: Uuid,
    pub label: String,
    pub environment: BinanceEnv,
    pub api_key_masked: String,
    pub can_trade_futures: bool,
    pub can_withdraw: bool,
    pub ip_restricted: bool,
    pub is_active: bool,
    pub last_verified_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Deserialize)]
pub struct CreateApiKeyRequest {
    pub label: String,
    pub environment: BinanceEnv,
    pub api_key: String,
    pub api_secret: String,
}

#[derive(Serialize)]
pub struct TestConnectionResponse {
    pub connected: bool,
    pub environment: BinanceEnv,
    pub available_usdt_balance: Decimal,
    pub can_trade_futures: bool,
    pub can_withdraw: bool,
    pub ip_restricted: bool,
}

pub async fn list_api_keys(
    State(state): State<AppState>,
    auth: AuthUser,
) -> ApiResult<Json<ApiKeysListResponse>> {
    let rows = sqlx::query_as::<_, ApiKeyRecord>(
        "SELECT * FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC",
    )
    .bind(auth.user_id)
    .fetch_all(&state.pool)
    .await?;

    let items = rows
        .into_iter()
        .map(|k| MaskedApiKey {
            id: k.id,
            label: k.label,
            environment: k.environment,
            api_key_masked: mask_key(&k.api_key),
            can_trade_futures: k.can_trade_futures,
            can_withdraw: k.can_withdraw,
            ip_restricted: k.ip_restricted,
            is_active: k.is_active,
            last_verified_at: k.last_verified_at,
        })
        .collect();

    Ok(Json(ApiKeysListResponse {
        server_static_ip: state.config.server_static_ip.clone(),
        items,
    }))
}

pub async fn create_api_key(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(payload): Json<CreateApiKeyRequest>,
) -> ApiResult<Json<MaskedApiKey>> {
    // Testnet mode is strictly restricted to ADMIN accounts.
    if payload.environment == BinanceEnv::Testnet && auth.role != UserRole::Admin {
        return Err(ApiError(AppError::Forbidden(
            "Testnet environment is restricted to administrators only".to_string(),
        )));
    }

    let api_key = payload.api_key.trim().to_string();
    let api_secret = payload.api_secret.trim().to_string();
    if api_key.len() < 16 || api_secret.len() < 16 || !api_key.is_ascii() || !api_secret.is_ascii()
    {
        return Err(ApiError(AppError::Validation(
            "invalid Binance API key or secret length".to_string(),
        )));
    }

    let base_url = state.config.rest_url_for(payload.environment).to_string();
    let client = BinanceFuturesClient::authenticated(
        base_url,
        payload.environment,
        api_key.clone(),
        api_secret.clone(),
    )?;
    let verification = client.verify_api_key().await?;

    if verification.can_withdraw {
        return Err(ApiError(AppError::Forbidden(
            "API key rejected: withdrawal permission must be disabled".to_string(),
        )));
    }

    let encrypted = state.cipher.encrypt(&api_secret)?;

    let rec = sqlx::query_as::<_, ApiKeyRecord>(
        r#"
        INSERT INTO api_keys (
            user_id, label, environment, api_key, api_secret_encrypted, encryption_nonce,
            can_trade_futures, can_withdraw, ip_restricted, last_verified_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, $8, NOW())
        RETURNING *
        "#,
    )
    .bind(auth.user_id)
    .bind(payload.label.trim())
    .bind(payload.environment)
    .bind(&api_key)
    .bind(&encrypted.ciphertext_b64)
    .bind(&encrypted.nonce_b64)
    .bind(verification.can_trade_futures)
    .bind(verification.ip_restricted)
    .fetch_one(&state.pool)
    .await?;

    Ok(Json(MaskedApiKey {
        id: rec.id,
        label: rec.label,
        environment: rec.environment,
        api_key_masked: mask_key(&rec.api_key),
        can_trade_futures: rec.can_trade_futures,
        can_withdraw: rec.can_withdraw,
        ip_restricted: rec.ip_restricted,
        is_active: rec.is_active,
        last_verified_at: rec.last_verified_at,
    }))
}

pub async fn test_api_key(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<TestConnectionResponse>> {
    let rec =
        sqlx::query_as::<_, ApiKeyRecord>("SELECT * FROM api_keys WHERE id = $1 AND user_id = $2")
            .bind(id)
            .bind(auth.user_id)
            .fetch_optional(&state.pool)
            .await?
            .ok_or_else(|| AppError::NotFound("API key not found".to_string()))?;

    let secret = state
        .cipher
        .decrypt(&rec.api_secret_encrypted, &rec.encryption_nonce)?;
    let base_url = state.config.rest_url_for(rec.environment).to_string();
    let client =
        BinanceFuturesClient::authenticated(base_url, rec.environment, rec.api_key, secret)?;
    let v = client.verify_api_key().await?;

    sqlx::query("UPDATE api_keys SET last_verified_at = NOW(), ip_restricted = $1 WHERE id = $2")
        .bind(v.ip_restricted)
        .bind(id)
        .execute(&state.pool)
        .await?;

    Ok(Json(TestConnectionResponse {
        connected: true,
        environment: rec.environment,
        available_usdt_balance: v.available_usdt_balance,
        can_trade_futures: v.can_trade_futures,
        can_withdraw: v.can_withdraw,
        ip_restricted: v.ip_restricted,
    }))
}

pub async fn delete_api_key(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<serde_json::Value>> {
    let running_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM bot_configs WHERE api_key_id = $1 AND user_id = $2 AND status = 'RUNNING'",
    )
    .bind(id)
    .bind(auth.user_id)
    .fetch_one(&state.pool)
    .await?;

    if running_count > 0 {
        return Err(ApiError(AppError::Conflict(
            "stop all running bots using this API key before deleting".to_string(),
        )));
    }

    let affected = sqlx::query("DELETE FROM api_keys WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(auth.user_id)
        .execute(&state.pool)
        .await?
        .rows_affected();

    if affected == 0 {
        return Err(ApiError(AppError::NotFound(
            "API key not found".to_string(),
        )));
    }

    Ok(Json(serde_json::json!({ "deleted": true })))
}

fn mask_key(raw: &str) -> String {
    if raw.len() <= 10 {
        return "****".to_string();
    }
    format!("{}...{}", &raw[..6], &raw[raw.len() - 4..])
}
