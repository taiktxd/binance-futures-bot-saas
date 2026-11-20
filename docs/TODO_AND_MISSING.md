> **BẮT BUỘC:** Đọc kỹ `/docs/ENGINEERING_STANDARDS.md` trước khi viết hoặc sửa bất kỳ dòng code nào trong dự án này.

# DANH SÁCH CÒN THIẾU & HƯỚNG DẪN CHO AI CODING TIẾP THEO

> **Trạng thái hiện tại:** EXTREME đã qua kiểm tra định dạng, Clippy và unit test Rust cục bộ. Chờ xác nhận CI GitHub và khớp lệnh trên Binance Demo. Live mặc định tắt.

---

## 1) [ĐÃ HOÀN THÀNH]

- Trang quản trị Testnet đã nối các API xác thực, khóa, bot, vị thế và lịch sử. Xem [checklist xác minh với Binance Demo](TESTNET_SMOKE_TEST.md).
- Đã chạy backtest BTCUSDT và ETHUSDT với [kết quả theo từng hồ sơ](BACKTEST.md).

- **Web EXTREME (`/frontend-static`):** Hoàn thiện giao diện 3 màu `#590907` / `#E8D2B5` / `#A5A79B`, logo gốc `logo.png`, chữ `EXTREME` chạy, sóng 3D Three.js Custom GLSL Shader, giá BTC/ETH/Vàng live, tỷ giá USD/VNĐ live (`open.er-api.com`), nút chuông Thông báo, Hướng dẫn 5 bước, Quản trị rủi ro ẩn tên bot & đòn bẩy không giới hạn, Kiếm tiền đối tác 2 tầng (rút tối đa `$5`/lệnh Bank VNĐ & BSC20, cam kết duyệt 24h), Testnet khóa riêng cho Admin. Đã nối đầy đủ API thật khi `EXTREME_CONFIG.API_URL != ""` cho toàn bộ các màn hình (`Auth`, `Dashboard`, `API Keys`, `Quản trị rủi ro`, `Lịch sử lệnh`, `Ví Credit` gồm VietQR/Crypto/Subscribe, `Kiếm tiền & Rút hoa hồng`, `Thông báo`, `Admin` gồm trạng thái engine, điều chỉnh Credit và duyệt rút hoa hồng).
- **Core Bot & Backend Rust (`/backend`):**
  - 1 chiến lược lõi duy nhất `ExtremeAdaptiveCore` (`crates/engine/src/strategy.rs`) + unit tests.
  - Thực thi đa người dùng `Semaphore(16)`, đòn bẩy `EXCHANGE_MAX` (`/fapi/v1/leverageBracket`), dời SL hòa vốn (`move_stop_loss`), khớp PnL thực tế từng cent (`/fapi/v1/userTrades`), tính phí HWM 20% bằng `rust_decimal` + `STOP_NEW_ENTRIES` + tự động cộng hoa hồng đối tác 2 tầng F1 (`15%–30%`) & F2 (`5%`) trong cùng transaction ACID.
  - Auth `$0` Credit -> nạp lần đầu `>= $1.00` tự thưởng `$5.00`, API Keys khóa `TESTNET` chỉ cho `ADMIN`, API rút tiền `<= $5.00` (`GET/POST /api/v1/earn/withdraw`, `GET /api/v1/earn/summary`), API nâng cấp gói thuê bao tháng (`POST /api/v1/wallet/subscribe` cho `STANDARD $29` / `PRO $79`), API Thông báo, và API Admin duyệt rút tiền (`GET /api/v1/admin/withdrawals`, `POST /api/v1/admin/withdrawals/:id/process` tự hoàn số dư hoa hồng khi `REJECTED`).
- **Database & Hạ tầng:** `supabase_schema.sql` (10 bảng + RLS), `.env.example`, `.github/workflows/build.yml`, `deploy/bot-engine.service`, và bộ tài liệu `/docs`.

---

## 2) [CÒN THIẾU / CHƯA LÀM]

### A. Tác vụ vận hành & kiểm chứng staging cần thực hiện ngoài máy cục bộ (theo thứ tự ưu tiên)
1. **Xác nhận CI Linux trên GitHub Actions và smoke test Binance Demo:** Push toàn bộ repo lên GitHub để `.github/workflows/build.yml` xuất artifact `bot-server-linux-x86_64`, nạp `supabase_schema.sql` vào Supabase staging, điền `.env` + `frontend-static/config.js`, rồi kiểm tra luồng ký và khớp lệnh trên staging bằng khóa Binance Demo theo `docs/TESTNET_SMOKE_TEST.md`.
2. **Mở rộng kiểm chứng chiến lược trước khi bật Live:** Chạy thêm các cửa sổ backtest độc lập, đo sai lệch khớp lệnh thực tế trên Binance Demo và bổ sung backtest tài sản vàng (`XAUUSDT` / `PAXGUSDT`) khi có dữ liệu hợp đồng phù hợp. Giữ `ENABLE_LIVE_TRADING=false` cho đến khi đạt chuẩn.

### B. Biến môi trường cần điền trước khi chạy thật
- **VPS (`/opt/bot-futures/.env`):** `DATABASE_URL`, `ENCRYPTION_MASTER_KEY`, `JWT_SECRET`, `SERVER_STATIC_IP`, `CORS_ALLOWED_ORIGINS`, `SEPAY_WEBHOOK_API_KEY`, `VIETQR_BANK_BIN`, `VIETQR_ACCOUNT_NO`, `VIETQR_ACCOUNT_NAME`, `NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_IPN_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_CHAT_ID`.
- **Cloudflare Pages (`/frontend-static/config.js`):** `API_URL` (link HTTPS của VPS) và `STATIC_IP` thật của VPS.

---

## 3) [HƯỚNG DẪN CHO AI TIẾP THEO]

1. Đọc `/docs/ENGINEERING_STANDARDS.md` và `/docs/ARCHITECTURE.md` trước khi sửa code; tuyệt đối giữ nguyên:
   - Không `.unwrap()`, không `.expect()` ngoài `#[cfg(test)]`, không `f64` tính tiền, không `todo!()`, không emoji.
   - Không để lộ tên chiến lược nội bộ cho khách; không giới hạn trần đòn bẩy; Testnet chỉ cho Admin; nạp lần đầu `>= $1` mới thưởng `$5`.
2. Toàn bộ phần code backend & frontend trong danh sách còn thiếu đã hoàn tất; bước tiếp theo là mục **2.A.1** (push GitHub chạy CI Linux + chạy smoke test Binance Demo trên staging) và **2.A.2** (backtest mở rộng trước khi xét bật Live).
3. Sau mỗi phiên code, cập nhật `/docs/PROGRESS.md` và `/docs/TODO_AND_MISSING.md` theo đúng 3 mục chuẩn.
