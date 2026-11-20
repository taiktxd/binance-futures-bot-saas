use crate::error::{AppError, AppResult};
use crate::models::BinanceEnv;
use rust_decimal::Decimal;
use std::env;
use std::str::FromStr;

#[derive(Debug, Clone)]
pub struct AppConfig {
    pub app_env: String,
    pub server_host: String,
    pub server_port: u16,
    pub server_static_ip: String,
    pub cors_allowed_origins: Vec<String>,

    pub database_url: String,
    pub database_max_connections: u32,

    pub encryption_master_key: [u8; 32],
    pub jwt_secret: String,
    pub jwt_expiration_hours: i64,

    pub enable_live_trading: bool,
    pub binance_market_feed_env: BinanceEnv,
    pub gold_primary_symbol: String,
    pub gold_testnet_fallback_symbol: String,
    pub binance_testnet_rest_url: String,
    pub binance_testnet_ws_url: String,
    pub binance_live_rest_url: String,
    pub binance_live_ws_url: String,

    pub signup_bonus_credit_usd: Decimal,
    pub profit_sharing_fee_rate: Decimal,
    pub low_credit_alert_threshold_usd: Decimal,
    pub max_allowed_leverage: i16,

    pub sepay_webhook_api_key: String,
    pub vnd_to_usd_exchange_rate: Decimal,
    pub vietqr_bank_bin: String,
    pub vietqr_account_no: String,
    pub vietqr_account_name: String,

    pub nowpayments_api_key: String,
    pub nowpayments_ipn_secret: String,

    pub telegram_bot_token: String,
    pub telegram_admin_chat_id: String,
}

impl AppConfig {
    pub fn from_env() -> AppResult<Self> {
        let _ = dotenvy::dotenv();

        let master_key_hex = require_env("ENCRYPTION_MASTER_KEY")?;
        let encryption_master_key = decode_hex_key32(&master_key_hex)?;

        let cors_raw = env::var("CORS_ALLOWED_ORIGINS")
            .unwrap_or_else(|_| "http://localhost:5173".to_string());
        let cors_allowed_origins = cors_raw
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        let feed_env = match env::var("BINANCE_MARKET_FEED_ENV")
            .unwrap_or_else(|_| "testnet".to_string())
            .to_lowercase()
            .as_str()
        {
            "live" => BinanceEnv::Live,
            _ => BinanceEnv::Testnet,
        };

        Ok(Self {
            app_env: env::var("APP_ENV").unwrap_or_else(|_| "development".to_string()),
            server_host: env::var("SERVER_HOST").unwrap_or_else(|_| "0.0.0.0".to_string()),
            server_port: parse_env("SERVER_PORT", 8080)?,
            server_static_ip: env::var("SERVER_STATIC_IP")
                .unwrap_or_else(|_| "127.0.0.1".to_string()),
            cors_allowed_origins,

            database_url: require_env("DATABASE_URL")?,
            database_max_connections: parse_env("DATABASE_MAX_CONNECTIONS", 10)?,

            encryption_master_key,
            jwt_secret: require_env("JWT_SECRET")?,
            jwt_expiration_hours: parse_env("JWT_EXPIRATION_HOURS", 24)?,

            enable_live_trading: parse_env("ENABLE_LIVE_TRADING", false)?,
            binance_market_feed_env: feed_env,
            gold_primary_symbol: env::var("GOLD_PRIMARY_SYMBOL")
                .unwrap_or_else(|_| "XAUUSDT".to_string()),
            gold_testnet_fallback_symbol: env::var("GOLD_TESTNET_FALLBACK_SYMBOL")
                .unwrap_or_else(|_| "PAXGUSDT".to_string()),
            binance_testnet_rest_url: env::var("BINANCE_TESTNET_REST_URL")
                .unwrap_or_else(|_| "https://demo-fapi.binance.com".to_string()),
            binance_testnet_ws_url: env::var("BINANCE_TESTNET_WS_URL")
                .unwrap_or_else(|_| "wss://demo-fstream.binance.com".to_string()),
            binance_live_rest_url: env::var("BINANCE_LIVE_REST_URL")
                .unwrap_or_else(|_| "https://fapi.binance.com".to_string()),
            binance_live_ws_url: env::var("BINANCE_LIVE_WS_URL")
                .unwrap_or_else(|_| "wss://fstream.binance.com".to_string()),

            signup_bonus_credit_usd: parse_decimal_env("SIGNUP_BONUS_CREDIT_USD", "5.00")?,
            profit_sharing_fee_rate: parse_decimal_env("PROFIT_SHARING_FEE_RATE", "0.20")?,
            low_credit_alert_threshold_usd: parse_decimal_env(
                "LOW_CREDIT_ALERT_THRESHOLD_USD",
                "5.00",
            )?,
            max_allowed_leverage: parse_env("MAX_ALLOWED_LEVERAGE", 20)?,

            sepay_webhook_api_key: env::var("SEPAY_WEBHOOK_API_KEY").unwrap_or_default(),
            vnd_to_usd_exchange_rate: parse_decimal_env("VND_TO_USD_EXCHANGE_RATE", "25500")?,
            vietqr_bank_bin: env::var("VIETQR_BANK_BIN").unwrap_or_else(|_| "970422".to_string()),
            vietqr_account_no: env::var("VIETQR_ACCOUNT_NO").unwrap_or_default(),
            vietqr_account_name: env::var("VIETQR_ACCOUNT_NAME").unwrap_or_default(),

            nowpayments_api_key: env::var("NOWPAYMENTS_API_KEY").unwrap_or_default(),
            nowpayments_ipn_secret: env::var("NOWPAYMENTS_IPN_SECRET").unwrap_or_default(),

            telegram_bot_token: env::var("TELEGRAM_BOT_TOKEN").unwrap_or_default(),
            telegram_admin_chat_id: env::var("TELEGRAM_ADMIN_CHAT_ID").unwrap_or_default(),
        })
    }

    pub fn rest_url_for(&self, env: BinanceEnv) -> &str {
        match env {
            BinanceEnv::Testnet => &self.binance_testnet_rest_url,
            BinanceEnv::Live => &self.binance_live_rest_url,
        }
    }

    pub fn ws_url_for(&self, env: BinanceEnv) -> &str {
        match env {
            BinanceEnv::Testnet => &self.binance_testnet_ws_url,
            BinanceEnv::Live => &self.binance_live_ws_url,
        }
    }
}

fn require_env(key: &str) -> AppResult<String> {
    env::var(key)
        .map_err(|_| AppError::Config(format!("missing required environment variable: {key}")))
}

fn parse_env<T: FromStr>(key: &str, default: T) -> AppResult<T> {
    match env::var(key) {
        Ok(val) => val
            .parse::<T>()
            .map_err(|_| AppError::Config(format!("invalid numeric value for {key}"))),
        Err(_) => Ok(default),
    }
}

fn parse_decimal_env(key: &str, default: &str) -> AppResult<Decimal> {
    let raw = env::var(key).unwrap_or_else(|_| default.to_string());
    Decimal::from_str(&raw)
        .map_err(|_| AppError::Config(format!("invalid decimal value for {key}")))
}

fn decode_hex_key32(hex_str: &str) -> AppResult<[u8; 32]> {
    let trimmed = hex_str.trim();
    if trimmed.len() != 64 {
        return Err(AppError::Config(
            "ENCRYPTION_MASTER_KEY must be exactly 64 hex characters (32 bytes)".to_string(),
        ));
    }

    let mut out = [0u8; 32];
    for (i, slot) in out.iter_mut().enumerate() {
        let pair = &trimmed[i * 2..i * 2 + 2];
        *slot = u8::from_str_radix(pair, 16).map_err(|_| {
            AppError::Config("ENCRYPTION_MASTER_KEY contains non-hex characters".to_string())
        })?;
    }
    Ok(out)
}
