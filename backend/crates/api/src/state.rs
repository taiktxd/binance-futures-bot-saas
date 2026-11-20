use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use binance::SymbolFilter;
use common::{Aes256GcmCipher, AppConfig, AppError, MarketTick};
use serde_json::json;
use sqlx::PgPool;
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::sync::broadcast;

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub config: Arc<AppConfig>,
    pub cipher: Arc<Aes256GcmCipher>,
    pub filters: Arc<HashMap<String, SymbolFilter>>,
    pub market_tx: broadcast::Sender<MarketTick>,
    pub ws_connected: Arc<AtomicBool>,
    pub active_gold_symbol: String,
}

pub struct ApiError(pub AppError);

impl From<AppError> for ApiError {
    fn from(value: AppError) -> Self {
        Self(value)
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(value: sqlx::Error) -> Self {
        Self(AppError::Database(value))
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code) = match &self.0 {
            AppError::Validation(_) => (StatusCode::BAD_REQUEST, "VALIDATION_ERROR"),
            AppError::Unauthorized(_) => (StatusCode::UNAUTHORIZED, "UNAUTHORIZED"),
            AppError::Forbidden(_) => (StatusCode::FORBIDDEN, "FORBIDDEN"),
            AppError::NotFound(_) => (StatusCode::NOT_FOUND, "NOT_FOUND"),
            AppError::Conflict(_) => (StatusCode::CONFLICT, "CONFLICT"),
            AppError::Exchange(_) => (StatusCode::BAD_GATEWAY, "EXCHANGE_ERROR"),
            AppError::Config(_)
            | AppError::Crypto(_)
            | AppError::Database(_)
            | AppError::Internal(_) => (StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL_ERROR"),
        };

        let body = Json(json!({
            "error": code,
            "message": self.0.to_string(),
        }));
        (status, body).into_response()
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
