-- ==============================================================================
-- EXTREME — SUPABASE POSTGRESQL SCHEMA (PRODUCTION SYNCED)
-- 1 Chiến lược lõi duy nhất: EXTREME_ADAPTIVE_CORE (tự động ghép theo Risk Profile)
-- Chỉ giao dịch: BTCUSDT, ETHUSDT, XAUUSDT (fallback PAXGUSDT trên Testnet Admin)
-- Luật kinh doanh:
--   - Nạp lần đầu >= $1.00 tự động thưởng $5.00 Credit (chống spam tài khoản ảo)
--   - Gói thuê bao tháng + 20% High-Water Mark (HWM)
--   - Không giới hạn đòn bẩy (hỗ trợ CUSTOM bất kỳ & EXCHANGE_MAX theo mức sàn)
--   - Hoa hồng đối tác 2 tầng + Rút tối đa $5.00/lệnh (Bank VNĐ & BSC20, duyệt 24h)
-- ==============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

DO $$ BEGIN CREATE TYPE user_role AS ENUM ('USER', 'ADMIN'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE binance_env AS ENUM ('TESTNET', 'LIVE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE margin_mode AS ENUM ('ISOLATED', 'CROSSED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE risk_profile AS ENUM ('SAFE', 'BALANCED', 'GROWTH'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE leverage_mode AS ENUM ('CUSTOM', 'EXCHANGE_MAX'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE bot_status AS ENUM ('STOPPED', 'RUNNING', 'STOP_NEW_ENTRIES', 'ERROR'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE position_side AS ENUM ('LONG', 'SHORT'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE position_status AS ENUM ('OPEN', 'CLOSED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE subscription_plan AS ENUM ('INACTIVE', 'TRIAL', 'STANDARD', 'PRO'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE withdraw_method AS ENUM ('BANK', 'BSC20'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE withdraw_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE TYPE credit_tx_type AS ENUM (
        'FIRST_DEPOSIT_BONUS',
        'DEPOSIT_VIETQR',
        'DEPOSIT_CRYPTO',
        'HWM_FEE_DEDUCTION',
        'SUBSCRIPTION_FEE',
        'COMMISSION_CONVERT',
        'ADMIN_ADJUSTMENT'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE deposit_provider AS ENUM ('SEPAY_VIETQR', 'NOWPAYMENTS_USDT_BEP20', 'ADMIN_MANUAL'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE deposit_status AS ENUM ('PENDING', 'PAID', 'EXPIRED', 'FAILED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 1. USERS (Khởi tạo $0.00 Credit; chỉ thưởng $5.00 khi nạp lần đầu >= $1.00)
CREATE TABLE IF NOT EXISTS users (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email                   VARCHAR(255) NOT NULL UNIQUE,
    password_hash           TEXT NOT NULL,
    role                    user_role NOT NULL DEFAULT 'USER',
    plan                    subscription_plan NOT NULL DEFAULT 'INACTIVE',
    plan_expires_at         TIMESTAMPTZ,
    telegram_chat_id        VARCHAR(64),

    -- Đối tác 2 tầng (F1 / F2)
    referral_code           VARCHAR(24) NOT NULL UNIQUE,
    referred_by_user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    commission_balance      NUMERIC(18, 8) NOT NULL DEFAULT 0.00000000,

    -- Ví Credit & HWM 20%
    credit_balance          NUMERIC(18, 8) NOT NULL DEFAULT 0.00000000,
    bonus_credit_granted    BOOLEAN NOT NULL DEFAULT FALSE,
    cumulative_net_pnl      NUMERIC(18, 8) NOT NULL DEFAULT 0.00000000,
    high_water_mark         NUMERIC(18, 8) NOT NULL DEFAULT 0.00000000,

    low_credit_alert_sent   BOOLEAN NOT NULL DEFAULT FALSE,
    zero_credit_alert_sent  BOOLEAN NOT NULL DEFAULT FALSE,
    is_active               BOOLEAN NOT NULL DEFAULT TRUE,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_hwm_non_negative CHECK (high_water_mark >= 0),
    CONSTRAINT chk_commission_non_negative CHECK (commission_balance >= 0)
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
CREATE INDEX IF NOT EXISTS idx_users_ref_code ON users (referral_code);
CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users (referred_by_user_id);

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 2. API KEYS (AES-256-GCM, Cấm quyền rút tiền, Testnet chỉ cho ADMIN ở tầng API)
CREATE TABLE IF NOT EXISTS api_keys (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label                   VARCHAR(100) NOT NULL DEFAULT 'Binance Futures Key',
    environment             binance_env NOT NULL DEFAULT 'LIVE',
    api_key                 TEXT NOT NULL,
    api_secret_encrypted    TEXT NOT NULL,
    encryption_nonce        TEXT NOT NULL,
    can_trade_futures       BOOLEAN NOT NULL DEFAULT FALSE,
    can_withdraw            BOOLEAN NOT NULL DEFAULT FALSE,
    ip_restricted           BOOLEAN NOT NULL DEFAULT FALSE,
    is_active               BOOLEAN NOT NULL DEFAULT TRUE,
    last_verified_at        TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_no_withdraw_permission CHECK (can_withdraw = FALSE),
    CONSTRAINT uq_user_api_key UNIQUE (user_id, api_key)
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys (user_id);
DROP TRIGGER IF EXISTS trg_api_keys_updated_at ON api_keys;
CREATE TRIGGER trg_api_keys_updated_at BEFORE UPDATE ON api_keys FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 3. BOT CONFIGS (1 Chiến lược lõi duy nhất, không giới hạn trần đòn bẩy)
CREATE TABLE IF NOT EXISTS bot_configs (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    api_key_id              UUID NOT NULL REFERENCES api_keys(id) ON DELETE RESTRICT,
    symbol                  VARCHAR(16) NOT NULL,
    risk_profile            risk_profile NOT NULL DEFAULT 'BALANCED',

    margin_type             margin_mode NOT NULL DEFAULT 'ISOLATED',
    leverage_mode           leverage_mode NOT NULL DEFAULT 'EXCHANGE_MAX',
    leverage                SMALLINT NOT NULL DEFAULT 10,
    order_margin_usdt       NUMERIC(18, 8) NOT NULL,
    max_open_positions      SMALLINT NOT NULL DEFAULT 1,

    sl_pct                  NUMERIC(10, 4) NOT NULL DEFAULT 1.5000,
    tp_pct                  NUMERIC(10, 4) NOT NULL DEFAULT 3.5000,
    enable_breakeven        BOOLEAN NOT NULL DEFAULT TRUE,

    status                  bot_status NOT NULL DEFAULT 'STOPPED',
    last_error              TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_symbol_whitelist CHECK (symbol IN ('BTCUSDT', 'ETHUSDT', 'XAUUSDT', 'PAXGUSDT')),
    CONSTRAINT chk_leverage_positive CHECK (leverage >= 1),
    CONSTRAINT chk_order_margin_positive CHECK (order_margin_usdt > 0),
    CONSTRAINT chk_sl_tp_positive CHECK (sl_pct > 0 AND tp_pct > 0)
);

CREATE INDEX IF NOT EXISTS idx_bot_configs_symbol_status ON bot_configs (symbol, status);
DROP TRIGGER IF EXISTS trg_bot_configs_updated_at ON bot_configs;
CREATE TRIGGER trg_bot_configs_updated_at BEFORE UPDATE ON bot_configs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 4. POSITIONS (Kèm cờ breakeven_moved bảo vệ lợi nhuận)
CREATE TABLE IF NOT EXISTS positions (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bot_config_id           UUID NOT NULL REFERENCES bot_configs(id) ON DELETE RESTRICT,
    symbol                  VARCHAR(16) NOT NULL,
    side                    position_side NOT NULL,
    margin_type             margin_mode NOT NULL DEFAULT 'ISOLATED',
    leverage                SMALLINT NOT NULL,
    entry_price             NUMERIC(18, 8) NOT NULL,
    quantity                NUMERIC(18, 8) NOT NULL,
    stop_loss_price         NUMERIC(18, 8) NOT NULL,
    take_profit_price       NUMERIC(18, 8) NOT NULL,
    unrealized_pnl          NUMERIC(18, 8) NOT NULL DEFAULT 0.00000000,
    breakeven_moved         BOOLEAN NOT NULL DEFAULT FALSE,
    binance_entry_order_id  VARCHAR(64),
    binance_sl_order_id     VARCHAR(64),
    binance_tp_order_id     VARCHAR(64),
    status                  position_status NOT NULL DEFAULT 'OPEN',
    opened_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at               TIMESTAMPTZ,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_pos_symbol_whitelist CHECK (symbol IN ('BTCUSDT', 'ETHUSDT', 'XAUUSDT', 'PAXGUSDT')),
    CONSTRAINT chk_pos_qty_positive CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS idx_positions_user_status ON positions (user_id, status);
DROP TRIGGER IF EXISTS trg_positions_updated_at ON positions;
CREATE TRIGGER trg_positions_updated_at BEFORE UPDATE ON positions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 5. TRADES (Đồng bộ chính xác từ /fapi/v1/userTrades)
CREATE TABLE IF NOT EXISTS trades (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bot_config_id           UUID NOT NULL REFERENCES bot_configs(id) ON DELETE RESTRICT,
    position_id             UUID REFERENCES positions(id) ON DELETE SET NULL,
    binance_order_id        VARCHAR(64),
    binance_trade_id        VARCHAR(64) UNIQUE,
    symbol                  VARCHAR(16) NOT NULL,
    side                    position_side NOT NULL,
    entry_price             NUMERIC(18, 8) NOT NULL,
    exit_price              NUMERIC(18, 8) NOT NULL,
    quantity                NUMERIC(18, 8) NOT NULL,
    gross_pnl               NUMERIC(18, 8) NOT NULL,
    exchange_fee            NUMERIC(18, 8) NOT NULL DEFAULT 0.00000000,
    funding_fee             NUMERIC(18, 8) NOT NULL DEFAULT 0.00000000,
    realized_pnl            NUMERIC(18, 8) NOT NULL,
    hwm_fee_charged         NUMERIC(18, 8) NOT NULL DEFAULT 0.00000000,
    close_reason            VARCHAR(32) NOT NULL DEFAULT 'EXCHANGE_TP_SL',
    executed_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trades_user_executed ON trades (user_id, executed_at DESC);

-- 6. CREDIT TRANSACTIONS
CREATE TABLE IF NOT EXISTS credit_transactions (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tx_type                 credit_tx_type NOT NULL,
    amount                  NUMERIC(18, 8) NOT NULL,
    balance_before          NUMERIC(18, 8) NOT NULL,
    balance_after           NUMERIC(18, 8) NOT NULL,
    cumulative_pnl_after    NUMERIC(18, 8),
    hwm_before              NUMERIC(18, 8),
    hwm_after               NUMERIC(18, 8),
    reference_trade_id      UUID REFERENCES trades(id) ON DELETE SET NULL,
    external_tx_id          VARCHAR(128) UNIQUE,
    note                    TEXT,
    metadata                JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credit_tx_user_created ON credit_transactions (user_id, created_at DESC);

-- 7. DEPOSIT ORDERS (Tối thiểu $1.00 để mở khóa thưởng $5.00 lần đầu)
CREATE TABLE IF NOT EXISTS deposit_orders (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider                deposit_provider NOT NULL,
    order_code              VARCHAR(64) NOT NULL UNIQUE,
    external_payment_id     VARCHAR(128) UNIQUE,
    pay_amount              NUMERIC(18, 8) NOT NULL,
    pay_currency            VARCHAR(16) NOT NULL,
    credit_usd_amount       NUMERIC(18, 8) NOT NULL,
    status                  deposit_status NOT NULL DEFAULT 'PENDING',
    raw_webhook_payload     JSONB,
    paid_at                 TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_deposit_min_one_usd CHECK (credit_usd_amount >= 1.0)
);

-- 8. WITHDRAW REQUESTS (Rút hoa hồng đối tác tối đa $5.00/lệnh, duyệt trong 24h)
CREATE TABLE IF NOT EXISTS withdraw_requests (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    method                  withdraw_method NOT NULL,
    amount_usd              NUMERIC(18, 8) NOT NULL,
    vnd_rate_snapshot       NUMERIC(18, 4),
    amount_vnd              NUMERIC(18, 2),
    bsc20_address           TEXT,
    bank_name               VARCHAR(100),
    bank_account_no         VARCHAR(64),
    bank_account_holder     VARCHAR(128),
    status                  withdraw_status NOT NULL DEFAULT 'PENDING',
    admin_note              TEXT,
    processed_at            TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_withdraw_max_five_usd CHECK (amount_usd > 0 AND amount_usd <= 5.0)
);

CREATE INDEX IF NOT EXISTS idx_withdraw_user_created ON withdraw_requests (user_id, created_at DESC);

-- 9. NOTIFICATIONS (Nút chuông thông báo trên Web)
CREATE TABLE IF NOT EXISTS notifications (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title                   VARCHAR(160) NOT NULL,
    body                    TEXT NOT NULL,
    is_read                 BOOLEAN NOT NULL DEFAULT FALSE,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications (user_id, is_read, created_at DESC);

-- 10. ALERT LOGS (Telegram)
CREATE TABLE IF NOT EXISTS alert_logs (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    alert_type              VARCHAR(64) NOT NULL,
    message                 TEXT NOT NULL,
    delivered               BOOLEAN NOT NULL DEFAULT FALSE,
    error_detail            TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE deposit_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE withdraw_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_logs ENABLE ROW LEVEL SECURITY;
