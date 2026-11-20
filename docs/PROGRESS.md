> **BẮT BUỘC:** Đọc kỹ `/docs/ENGINEERING_STANDARDS.md` trước khi viết hoặc sửa bất kỳ dòng code nào trong dự án này.

# NHẬT KÝ TIẾN ĐỘ DỰ ÁN EXTREME (PROGRESS LOG)

> **Cập nhật lần cuối:** 2026-11-20 (Hoàn thiện API đối tác 2 tầng, duyệt rút tiền Admin, gói thuê bao tháng và nối đầy đủ API thật cho Web EXTREME)

---

## 1) [ĐÃ HOÀN THÀNH]

- Đã bổ sung `Cargo.lock`, sửa lỗi biên dịch và Clippy, kiểm tra định dạng, chạy 9 unit test Rust (`common`, `binance`, `engine`) và build release trên Windows. Workflow Linux dùng `--locked` và chỉ deploy khi chọn tùy chọn deploy.
- **Hoa hồng đối tác 2 tầng tự động & Duyệt rút tiền Admin & Gói thuê bao tháng:**
  - `crates/common/src/hwm.rs`: bổ sung các hàm `Decimal` tính cấp bậc đối tác F1 (`15%–30%` HWM, `20%–35%` gói tháng theo số khách F1 kích hoạt), nhánh F2 (`5%` HWM) và bảng giá gói thuê bao (`STANDARD $29` / `PRO $79`) kèm unit tests.
  - `crates/engine/src/hwm_billing.rs`: mỗi khi thu `fee_charged > 0` ở môi trường `LIVE` từ user có `referred_by_user_id`, tự động cộng hoa hồng F1 và F2 vào `commission_balance` trong cùng transaction ACID và ghi thông báo vào bảng `notifications`.
  - `crates/api/src/routes/admin.rs`: bổ sung `GET /api/v1/admin/withdrawals` và `POST /api/v1/admin/withdrawals/:id/process` (`APPROVED` / `REJECTED`; nếu `REJECTED` tự động hoàn `commission_balance` và đẩy thông báo vào `notifications`).
  - `crates/api/src/routes/wallet.rs`: bổ sung `POST /api/v1/wallet/subscribe` (nâng cấp `STANDARD $29` / `PRO $79` trừ Ví Credit, gia hạn 30 ngày, tự cộng hoa hồng gói tháng cho F1), `GET /api/v1/earn/summary` và `GET /api/v1/earn/withdraw`.
- **Nối đầy đủ API thật cho `/frontend-static/index.html` (khi `EXTREME_CONFIG.API_URL != ""`):**
  - Toàn bộ màn hình đã nối `fetch()` thật với đủ trạng thái `loading` / `error` / `empty` (đồng thời giữ nguyên chế độ xem thử cục bộ khi `API_URL == ""`): Auth kèm `referral_code`, Dashboard (`/api/v1/dashboard/summary` + vị thế mở), API Keys (`/api/v1/api-keys` + kiểm tra số dư + xóa), Quản trị rủi ro (`/api/v1/bots` + chọn khóa API + bật/tắt + Breakeven), Lịch sử lệnh (`/api/v1/trades` + lọc cặp), Ví Credit (`/api/v1/wallet/*` gồm VietQR, Crypto, nâng cấp gói `$29`/`$79`, sao kê), Kiếm tiền & Rút hoa hồng (`/api/v1/earn/summary`, `/api/v1/earn/withdraw`), Thông báo (`/api/v1/notifications`), và Admin (`/api/v1/admin/engine-status`, `/api/v1/admin/users`, `/api/v1/admin/withdrawals`).
- Trang `frontend-static/testnet.html` nối API thật cho tài khoản ADMIN và khóa TESTNET. Backend dùng Binance Demo và Algo Order cho SL/TP, cô lập Credit/HWM của Testnet. Đã xác minh bản release kết nối PostgreSQL và WebSocket công khai của Binance Demo. Đã kiểm tra luồng web, API Rust và PostgreSQL bằng sàn mô phỏng có kiểm chữ ký, bao gồm khôi phục mã lệnh khi nhận phản hồi 503, khởi động lại backend khi còn vị thế và đối soát lệnh đã đóng.
- Đã chạy [backtest BTCUSDT và ETHUSDT](BACKTEST.md) với phí, trượt giá và funding. Giữ Live tắt mặc định.

- **Động cơ Chiến lược Lõi Duy nhất (`ExtremeAdaptiveCore` — `crates/engine/src/strategy.rs`):**
  - Gộp toàn bộ năng lực phân tích vào đúng **1 chiến lược thích ứng đa chế độ** (tuyệt đối không lộ tên chiến lược cho khách hàng): EMA Ribbon `9/21/50/200`, MACD `12/26/9`, RSI `14`, Bollinger Bands `20/2.0`, bộ lọc biến động ATR% (chặn thị trường chết thanh khoản và flash crash), chấm điểm hội tụ `0..100` tự khớp với khẩu vị rủi ro (`SAFE >= 80`, `BALANCED >= 70`, `GROWTH >= 60`) và cơ chế chống nhiễu `cooldown_bars = 3`.
- **Core Engine Thực thi & Quản trị Vị thế Chủ động (`crates/engine/src/executor.rs` + `crates/binance/src/rest.rs`):**
  - Bỏ hoàn toàn trần đòn bẩy `<= 20x`: hỗ trợ nhập tự do (`Custom`) và chế độ **`EXCHANGE_MAX`** tự truy vấn `/fapi/v1/leverageBracket` lấy mức tối đa của sàn Binance.
  - Giới hạn concurrency an toàn bằng `Semaphore(16)` cho VPS 1 vCPU / 2GB RAM.
  - Tự động dời Stop Loss về hòa vốn (**Breakeven**) khi vị thế đạt `>= 50%` mục tiêu TP.
  - Khớp PnL chính xác từng cent bằng `GET /fapi/v1/userTrades` trước khi trừ phí HWM 20% bằng `rust_decimal` (và giữ nguyên quy tắc `STOP_NEW_ENTRIES` không bao giờ ép đóng vị thế khi Credit `<= 0`).
- **Đồng bộ 100% SQL Schema & API Backend (`supabase_schema.sql` + `crates/api`):**
  - Khởi tạo tài khoản `$0.00` Credit, tự động thưởng `$5.00` 1 lần duy nhất khi nạp lần đầu `>= $1.00` (chống spam).
  - Khóa chế độ `TESTNET` chỉ cho `ADMIN` trong `POST /api/v1/api-keys`.
  - Bổ sung bảng & API: `withdraw_requests` (tối đa `$5.00`/lệnh, Bank VNĐ & BSC20, duyệt 24h), `notifications` (nút chuông thông báo), `referral_code` & `commission_balance`.
- **Frontend Web EXTREME (`/frontend-static`):**
  - Đã gộp bản web `extreme-v13` hoàn chỉnh (3 màu `#590907` / `#E8D2B5` / `#A5A79B`, logo gốc, chữ chạy, Three.js GLSL Shader, giá BTC/ETH/Vàng live, tỷ giá USD/VNĐ tự động, nút chuông Thông báo, Hướng dẫn 5 bước, Kiếm tiền đối tác).

---

## 2) [CÒN THIẾU / CHƯA LÀM]

- Chưa chạy workflow trên GitHub Actions để nhận artifact Linux. Bản workspace hiện tại không có metadata Git hay remote để kích hoạt workflow.
- Đã kiểm tra schema trên PostgreSQL cục bộ. Cần cấu hình Supabase/PostgreSQL staging và xác nhận được khớp lệnh bằng khóa Binance Demo thực theo [checklist](TESTNET_SMOKE_TEST.md).
- Cần mở rộng số giai đoạn kiểm tra trước Live. Vàng chưa nằm trong đợt backtest này.

---

## 3) [HƯỚNG DẪN CHO AI TIẾP THEO]

1. Push toàn bộ thư mục dự án lên GitHub để `.github/workflows/build.yml` tự chạy `cargo fmt`, `cargo clippy`, `cargo test` và build ra binary `bot-server-linux-x86_64`.
2. Nạp `supabase_schema.sql` vào Supabase SQL Editor, cài `bot-server` + `.env` + `deploy/bot-engine.service` lên VPS Ubuntu 2GB RAM.
3. Trỏ `frontend-static/config.js` vào API staging, hoàn thành [checklist Testnet](TESTNET_SMOKE_TEST.md) và xem lại [kết quả backtest](BACKTEST.md) trước khi xét bật Live.
