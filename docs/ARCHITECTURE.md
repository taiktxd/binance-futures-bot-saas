> **BẮT BUỘC:** Đọc kỹ `/docs/ENGINEERING_STANDARDS.md` trước khi viết hoặc sửa bất kỳ dòng code nào trong dự án này.

# KIẾN TRÚC HỆ THỐNG — EXTREME (BINANCE USDⓈ-M FUTURES SAAS)

> **Thương hiệu & Bảng màu bắt buộc:** **EXTREME** — 3 màu chủ đạo `#590907` (Oxblood), `#E8D2B5` (Champagne), `#A5A79B` (Sage Stone) trên nền trầm dịu mắt `#110E0E`, font `Be Vietnam Pro` + `JetBrains Mono` (`tabular-nums`), sử dụng nguyên bản `/frontend-static/logo.png` và hiệu ứng chữ `EXTREME` chạy.
> **Phạm vi giao dịch:** Chỉ **Binance USDⓈ-M Futures** với 3 tài sản whitelist cứng: `BTCUSDT`, `ETHUSDT`, `XAUUSDT` (fallback `PAXGUSDT` trên Testnet Admin).
> **Mô hình kinh doanh:** Gói thuê bao tháng (`TRIAL`, `STANDARD $29`, `PRO $79`) + **20% High-Water Mark (HWM)** trừ vào Ví Credit. Chống spam: tài khoản mới khởi tạo `$0.00` Credit, nạp lần đầu tối thiểu **`$1.00`** sẽ tự động thưởng **`$5.00`** Credit (1 lần duy nhất).
> **Hạ tầng mục tiêu:** VPS Linux Ubuntu 22.04/24.04 (1 vCPU / 2GB RAM / 1 IP tĩnh) + Supabase PostgreSQL Free Tier + Cloudflare Pages.

---

## 1. Sơ đồ Kiến trúc Tổng thể

```text
+-----------------------------------------------------------------------------+
|  FRONTEND WEB (Cloudflare Pages — /frontend-static)                         |
|  - 3 màu #590907 / #E8D2B5 / #A5A79B, Three.js Custom GLSL Shader           |
|  - Giá BTC/ETH/Vàng live + Tỷ giá USD/VNĐ live (open.er-api.com)            |
|  - Cấu hình rủi ro ẩn tên chiến lược, đòn bẩy theo hạn mức sàn              |
|  - Kiếm tiền đối tác 2 tầng (rút tối đa $5/lệnh, Bank VNĐ & BSC20, 24h)     |
+----------------------------+------------------------------+-----------------+
                             | HTTPS REST API (JWT)         | WSS (/ws/market)
                             v                              v
+-----------------------------------------------------------------------------+
|  VPS UBUNTU (1 vCPU / 2GB RAM / 1 IP TĨNH) — SINGLE RUST BINARY             |
|  systemd: bot-engine.service (MemoryMax=1400M, Restart=always)              |
|                                                                             |
|  +-----------------------+     +------------------------------------------+ |
|  | crates/api (Axum)     |     | crates/engine (Event-Driven Multi-User)  | |
|  | - Auth (Argon2 + JWT) |     |  [1] Shared Combined WS Market Feed      | |
|  | - API Keys (AES-GCM,  |     |      (btcusdt, ethusdt, xauusdt/paxgusdt)| |
|  |   TESTNET chỉ ADMIN)  |     |                |                         | |
|  | - Risk & Bot Control  |     |                v                         | |
|  | - Wallet ($1->+$5)    |     |  [2] ExtremeAdaptiveCore (1 Chiến lược)  | |
|  | - Withdraw (max $5)   |     |      - EMA 9/21/50/200 + MACD + RSI + BB | |
|  | - Notifications Bell  |     |      - ATR Volatility Gate + Cooldown    | |
|  | - Webhooks SePay/NOW  |     |      - Score 0..100 -> RiskProfile       | |
|  | - Admin Console       |     |                |                         | |
|  +-----------+-----------+     |                v                         | |
|              |                 |  [3] Execution Worker (Semaphore 16)     | |
|              |                 |      - Leverage: CUSTOM or EXCHANGE_MAX  | |
|              |                 |      - Bracket Order: Market + SL + TP   | |
|              |                 |      - Active Breakeven SL @ 50% TP      | |
|              |                 |                |                         | |
|              |                 |                v                         | |
|              |                 |  [4] HWM 20% Billing (rust_decimal)      | |
|              |                 |      - Exact /fapi/v1/userTrades PnL     | |
|              |                 |      - Credit <= 0 -> STOP_NEW_ENTRIES   | |
|              |                 |      - Never force-close open positions  | |
|              v                 +----------------+-------------------------+ |
|  +------------------------------------------------------------------------+ |
|  | crates/binance (tokio-tungstenite + reqwest + HMAC-SHA256)             | |
|  | - tickSize/stepSize Decimal, recvWindow sync, 429/418 backoff          | |
|  +-----------------------------------+------------------------------------+ |
+--------------------------------------|--------------------------------------+
                                       |
          +----------------------------+----------------------------+
          v                            v                            v
+-------------------+      +-----------------------+     +--------------------+
| Supabase Postgres |      | Binance USD-M Futures |     | External Services  |
| (10 Core Tables)  |      | (IP Whitelist = VPS)  |     | - SePay / VietQR   |
| - NUMERIC(18,8)   |      | - /fapi/v1/userTrades |     | - NOWPayments      |
| - RLS Enabled     |      | - leverageBracket     |     | - Telegram Bot API |
+-------------------+      +-----------------------+     +--------------------+
```

---

## 2. Database Schema (10 Bảng trong `supabase_schema.sql`)

Mọi cột tài chính bắt buộc dùng `NUMERIC(18, 8)` ánh xạ trực tiếp sang `rust_decimal::Decimal`.

| Bảng | Vai trò chính | Các cột & ràng buộc trọng yếu |
| :--- | :--- | :--- |
| `users` | Tài khoản, Ví Credit, HWM, Đối tác | `credit_balance (DEFAULT 0)`, `bonus_credit_granted (DEFAULT FALSE)`, `plan`, `referral_code (UNIQUE)`, `referred_by_user_id`, `commission_balance`, `cumulative_net_pnl`, `high_water_mark` |
| `api_keys` | Khóa API Binance mã hóa AES-256-GCM | `environment (LIVE/TESTNET)`, `api_secret_encrypted`, `encryption_nonce`, `can_withdraw (CHECK = FALSE)` |
| `bot_configs` | Cấu hình rủi ro từng cặp (ẩn tên bot) | `symbol (Whitelist)`, `risk_profile (SAFE/BALANCED/GROWTH)`, `margin_type`, `leverage_mode (CUSTOM/EXCHANGE_MAX)`, `leverage (CHECK >= 1)`, `order_margin_usdt`, `sl_pct`, `tp_pct`, `enable_breakeven`, `status` |
| `positions` | Vị thế Futures đang mở / đã đóng | `entry_price`, `quantity`, `stop_loss_price`, `take_profit_price`, `unrealized_pnl`, `breakeven_moved`, `binance_*_order_id` |
| `trades` | Lịch sử lệnh chốt khớp `/fapi/v1/userTrades` | `binance_trade_id (UNIQUE)`, `entry_price`, `exit_price`, `gross_pnl`, `exchange_fee`, `funding_fee`, `realized_pnl`, `hwm_fee_charged` |
| `credit_transactions` | Sao kê minh bạch Ví Credit & HWM | `tx_type (FIRST_DEPOSIT_BONUS / DEPOSIT_* / HWM_FEE_DEDUCTION / ...)`, `amount`, `balance_before/after`, `hwm_before/after`, `external_tx_id (UNIQUE)` |
| `deposit_orders` | Đơn nạp VietQR & USDT BEP20 | `order_code (UNIQUE)`, `credit_usd_amount (CHECK >= 1.0)`, `status` |
| `withdraw_requests` | Yêu cầu rút hoa hồng đối tác | `method (BANK/BSC20)`, `amount_usd (CHECK > 0 AND <= 5.0)`, `vnd_rate_snapshot`, `amount_vnd`, `bsc20_address`, `bank_name`, `bank_account_no`, `bank_account_holder`, `status` |
| `notifications` | Thông báo đẩy vào nút chuông Header | `user_id`, `title`, `body`, `is_read`, `created_at` |
| `alert_logs` | Nhật ký cảnh báo Telegram | `user_id`, `alert_type`, `message`, `delivered`, `error_detail` |

---

## 3. Chiến lược Lõi Duy nhất (`ExtremeAdaptiveCore`) & Quy tắc An toàn

1. **1 Chiến lược Thích ứng Duy nhất (`crates/engine/src/strategy.rs`):**
   - Kết hợp EMA `9/21/50/200`, MACD `12/26/9`, RSI `14`, Bollinger Bands `20/2.0`, bộ lọc biến động `ATR% (0.08% .. 4.5%)` và chống spam `cooldown_bars = 3`.
   - Tự nhận diện thị trường **Trending** hay **MeanReversion**, chấm điểm hội tụ `0..100` và lọc theo `RiskProfile` của từng user: `SAFE >= 80`, `BALANCED >= 70`, `GROWTH >= 60`.
2. **Đòn bẩy theo hạn mức sàn (Không giới hạn trần):**
   - `LeverageMode::ExchangeMax` tự gọi `GET /fapi/v1/leverageBracket` để lấy mức đòn bẩy cao nhất sàn Binance cấp cho tài khoản/cặp đó.
   - `LeverageMode::Custom` gửi đúng mức đòn bẩy người dùng nhập (`>= 1`).
3. **Active Breakeven & HWM 20%:**
   - Khi giá đi được `>= 50%` quãng đường tới TP và `enable_breakeven = TRUE`, tự động dời `STOP_MARKET` về `entry_price`.
   - Khi vị thế đóng, đồng bộ `realizedPnl` & `commission` từ `GET /fapi/v1/userTrades`, tính phí 20% HWM trong transaction `SELECT ... FOR UPDATE`.
   - Khi `credit_balance <= 0`: chỉ chuyển bot sang `STOP_NEW_ENTRIES`, **tuyệt đối không force close vị thế đang mở**.

---

## 4. Danh sách REST API & WebSocket Endpoints (`crates/api/src/main.rs`)

- **System & Realtime:** `GET /health`, `GET /ws/market`
- **Auth:** `POST /api/v1/auth/register` (`$0` Credit + mã giới thiệu), `POST /api/v1/auth/login`, `GET /api/v1/auth/me`
- **API Keys:** `GET /api/v1/api-keys`, `POST /api/v1/api-keys` (chặn `canWithdraw = true`, `TESTNET` chỉ cho `ADMIN`), `POST /api/v1/api-keys/:id/test`, `DELETE /api/v1/api-keys/:id`
- **Risk & Bots:** `GET/POST /api/v1/bots`, `PATCH /api/v1/bots/:id`, `POST /api/v1/bots/:id/start`, `POST /api/v1/bots/:id/stop`, `GET /api/v1/dashboard/summary`, `GET /api/v1/positions`, `GET /api/v1/trades`
- **Wallet, Withdrawals & Notifications:** `GET /api/v1/wallet/transactions`, `POST /api/v1/wallet/deposits/vietqr`, `POST /api/v1/wallet/deposits/crypto`, `POST /api/v1/wallet/subscribe`, `GET /api/v1/earn/summary`, `GET/POST /api/v1/earn/withdraw`, `GET /api/v1/notifications`, `POST /api/v1/notifications/read-all`, `POST /api/v1/webhooks/sepay`, `POST /api/v1/webhooks/nowpayments`
- **Admin:** `GET /api/v1/admin/users`, `POST /api/v1/admin/users/:id/credit-adjust`, `GET /api/v1/admin/engine-status`, `GET /api/v1/admin/withdrawals`, `POST /api/v1/admin/withdrawals/:id/process`, `POST /api/v1/admin/bots/:id/test-order` (chỉ `TESTNET`)
