use crate::error::{AppError, AppResult};
use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[sqlx(type_name = "user_role", rename_all = "SCREAMING_SNAKE_CASE")]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum UserRole {
    User,
    Admin,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[sqlx(type_name = "binance_env", rename_all = "SCREAMING_SNAKE_CASE")]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BinanceEnv {
    Testnet,
    Live,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[sqlx(type_name = "margin_mode", rename_all = "SCREAMING_SNAKE_CASE")]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MarginMode {
    Isolated,
    Crossed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[sqlx(type_name = "risk_profile", rename_all = "SCREAMING_SNAKE_CASE")]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RiskProfile {
    Safe,
    Balanced,
    Growth,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[sqlx(type_name = "leverage_mode", rename_all = "SCREAMING_SNAKE_CASE")]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LeverageMode {
    Custom,
    ExchangeMax,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[sqlx(type_name = "bot_status", rename_all = "SCREAMING_SNAKE_CASE")]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BotStatus {
    Stopped,
    Running,
    StopNewEntries,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[sqlx(type_name = "position_side", rename_all = "SCREAMING_SNAKE_CASE")]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PositionSide {
    Long,
    Short,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[sqlx(type_name = "position_status", rename_all = "SCREAMING_SNAKE_CASE")]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PositionStatus {
    Open,
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[sqlx(type_name = "subscription_plan", rename_all = "SCREAMING_SNAKE_CASE")]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SubscriptionPlan {
    Inactive,
    Trial,
    Standard,
    Pro,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[sqlx(type_name = "withdraw_method", rename_all = "SCREAMING_SNAKE_CASE")]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum WithdrawMethod {
    Bank,
    Bsc20,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[sqlx(type_name = "withdraw_status", rename_all = "SCREAMING_SNAKE_CASE")]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum WithdrawStatus {
    Pending,
    Approved,
    Rejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[sqlx(type_name = "credit_tx_type", rename_all = "SCREAMING_SNAKE_CASE")]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CreditTxType {
    FirstDepositBonus,
    DepositVietqr,
    DepositCrypto,
    HwmFeeDeduction,
    SubscriptionFee,
    CommissionConvert,
    AdminAdjustment,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[sqlx(type_name = "deposit_provider", rename_all = "SCREAMING_SNAKE_CASE")]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DepositProvider {
    SepayVietqr,
    NowpaymentsUsdtBep20,
    AdminManual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[sqlx(type_name = "deposit_status", rename_all = "SCREAMING_SNAKE_CASE")]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DepositStatus {
    Pending,
    Paid,
    Expired,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum AllowedSymbol {
    BTCUSDT,
    ETHUSDT,
    XAUUSDT,
    PAXGUSDT,
}

impl AllowedSymbol {
    pub fn parse(raw: &str) -> AppResult<Self> {
        match raw.trim().to_uppercase().as_str() {
            "BTCUSDT" => Ok(Self::BTCUSDT),
            "ETHUSDT" => Ok(Self::ETHUSDT),
            "XAUUSDT" => Ok(Self::XAUUSDT),
            "PAXGUSDT" => Ok(Self::PAXGUSDT),
            other => Err(AppError::Validation(format!(
                "symbol '{other}' is not allowed; supported symbols: BTCUSDT, ETHUSDT, XAUUSDT, PAXGUSDT"
            ))),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::BTCUSDT => "BTCUSDT",
            Self::ETHUSDT => "ETHUSDT",
            Self::XAUUSDT => "XAUUSDT",
            Self::PAXGUSDT => "PAXGUSDT",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct UserRecord {
    pub id: Uuid,
    pub email: String,
    #[serde(skip_serializing)]
    pub password_hash: String,
    pub role: UserRole,
    pub plan: SubscriptionPlan,
    pub plan_expires_at: Option<DateTime<Utc>>,
    pub telegram_chat_id: Option<String>,
    pub referral_code: String,
    pub referred_by_user_id: Option<Uuid>,
    pub commission_balance: Decimal,
    pub credit_balance: Decimal,
    pub bonus_credit_granted: bool,
    pub cumulative_net_pnl: Decimal,
    pub high_water_mark: Decimal,
    pub low_credit_alert_sent: bool,
    pub zero_credit_alert_sent: bool,
    pub is_active: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ApiKeyRecord {
    pub id: Uuid,
    pub user_id: Uuid,
    pub label: String,
    pub environment: BinanceEnv,
    pub api_key: String,
    #[serde(skip_serializing)]
    pub api_secret_encrypted: String,
    #[serde(skip_serializing)]
    pub encryption_nonce: String,
    pub can_trade_futures: bool,
    pub can_withdraw: bool,
    pub ip_restricted: bool,
    pub is_active: bool,
    pub last_verified_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct BotConfigRecord {
    pub id: Uuid,
    pub user_id: Uuid,
    pub api_key_id: Uuid,
    pub symbol: String,
    pub risk_profile: RiskProfile,
    pub margin_type: MarginMode,
    pub leverage_mode: LeverageMode,
    pub leverage: i16,
    pub order_margin_usdt: Decimal,
    pub max_open_positions: i16,
    pub sl_pct: Decimal,
    pub tp_pct: Decimal,
    pub enable_breakeven: bool,
    pub status: BotStatus,
    pub last_error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct PositionRecord {
    pub id: Uuid,
    pub user_id: Uuid,
    pub bot_config_id: Uuid,
    pub symbol: String,
    pub side: PositionSide,
    pub margin_type: MarginMode,
    pub leverage: i16,
    pub entry_price: Decimal,
    pub quantity: Decimal,
    pub stop_loss_price: Decimal,
    pub take_profit_price: Decimal,
    pub unrealized_pnl: Decimal,
    pub breakeven_moved: bool,
    pub binance_entry_order_id: Option<String>,
    pub binance_sl_order_id: Option<String>,
    pub binance_tp_order_id: Option<String>,
    pub status: PositionStatus,
    pub opened_at: DateTime<Utc>,
    pub closed_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct TradeRecord {
    pub id: Uuid,
    pub user_id: Uuid,
    pub bot_config_id: Uuid,
    pub position_id: Option<Uuid>,
    pub binance_order_id: Option<String>,
    pub binance_trade_id: Option<String>,
    pub symbol: String,
    pub side: PositionSide,
    pub entry_price: Decimal,
    pub exit_price: Decimal,
    pub quantity: Decimal,
    pub gross_pnl: Decimal,
    pub exchange_fee: Decimal,
    pub funding_fee: Decimal,
    pub realized_pnl: Decimal,
    pub hwm_fee_charged: Decimal,
    pub close_reason: String,
    pub executed_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct CreditTransactionRecord {
    pub id: Uuid,
    pub user_id: Uuid,
    pub tx_type: CreditTxType,
    pub amount: Decimal,
    pub balance_before: Decimal,
    pub balance_after: Decimal,
    pub cumulative_pnl_after: Option<Decimal>,
    pub hwm_before: Option<Decimal>,
    pub hwm_after: Option<Decimal>,
    pub reference_trade_id: Option<Uuid>,
    pub external_tx_id: Option<String>,
    pub note: Option<String>,
    pub metadata: serde_json::Value,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct DepositOrderRecord {
    pub id: Uuid,
    pub user_id: Uuid,
    pub provider: DepositProvider,
    pub order_code: String,
    pub external_payment_id: Option<String>,
    pub pay_amount: Decimal,
    pub pay_currency: String,
    pub credit_usd_amount: Decimal,
    pub status: DepositStatus,
    pub raw_webhook_payload: Option<serde_json::Value>,
    pub paid_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct WithdrawRequestRecord {
    pub id: Uuid,
    pub user_id: Uuid,
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

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct NotificationRecord {
    pub id: Uuid,
    pub user_id: Uuid,
    pub title: String,
    pub body: String,
    pub is_read: bool,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketTick {
    pub symbol: String,
    pub mark_price: Decimal,
    pub open_price: Decimal,
    pub high_price: Decimal,
    pub low_price: Decimal,
    pub close_price: Decimal,
    pub change_pct_24h: Decimal,
    pub is_kline_closed: bool,
    pub event_time_ms: i64,
}
