> **BẮT BUỘC:** Đọc kỹ `/docs/ENGINEERING_STANDARDS.md` trước khi triển khai hoặc chỉnh sửa cấu hình.

# HƯỚNG DẪN TESTNET 0 ĐỒNG & DEPLOY PRODUCTION (VPS 2GB RAM + CLOUDFLARE PAGES)

---

## 1. Khởi tạo Cơ sở dữ liệu (Supabase Free Tier)
1. Tạo project mới trên Supabase (chọn region gần VPS, ví dụ `ap-southeast-1`).
2. Mở **SQL Editor**, dán toàn bộ nội dung file `supabase_schema.sql` và nhấn **Run**.
3. Lấy chuỗi kết nối PostgreSQL (kết nối trực tiếp hoặc **Session Pooler**, kèm `?sslmode=require`) điền vào `DATABASE_URL` trong `.env`.

## 2. Xác minh Binance Futures Testnet trên staging

Cấu hình hệ thống ở chế độ `testnet` với `ENABLE_LIVE_TRADING=false`. Dùng trang `frontend-static/testnet.html` và làm theo [checklist Testnet](TESTNET_SMOKE_TEST.md). Tài khoản mới có Credit 0 và có thể chạy Testnet sau khi được cấp vai trò ADMIN.

## 3. Build Binary ngoài VPS (GitHub Actions) & Deploy lên VPS Ubuntu 2GB RAM
> **Cấm biên dịch (`cargo build`) trực tiếp trên VPS 1 vCPU / 2GB RAM.**

1. Push repo lên GitHub. Workflow `.github/workflows/build.yml` sẽ tự chạy `rustfmt`, `clippy`, `cargo test` và build ra artifact `bot-server-linux-x86_64`.
2. Trên VPS Ubuntu 22.04/24.04:
   ```bash
   sudo useradd -r -s /bin/false botuser
   sudo mkdir -p /opt/bot-futures/logs
   sudo chown -R botuser:botuser /opt/bot-futures
   ```
3. Tải file binary `bot-server` từ GitHub Actions artifact vào `/opt/bot-futures/bot-server` và cấp quyền thực thi (`chmod +x /opt/bot-futures/bot-server`).
4. Tạo `/opt/bot-futures/.env` từ `.env.example`, tạo khóa mã hóa bằng `openssl rand -hex 32` cho `ENCRYPTION_MASTER_KEY` và `openssl rand -base64 48` cho `JWT_SECRET`, điền đúng `SERVER_STATIC_IP` của VPS.
5. Cài đặt service chạy ngầm 24/7:
   ```bash
   sudo cp deploy/bot-engine.service /etc/systemd/system/bot-engine.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now bot-engine.service
   sudo journalctl -u bot-engine.service -f
   ```
6. Cấu hình Reverse Proxy (Caddy hoặc Nginx) trỏ `https://api.your-domain.com` về `127.0.0.1:8080` (bật WebSocket upgrade cho `/ws/market`).

## 4. Deploy Frontend Three.js lên Cloudflare Pages (Miễn phí)
1. Kết nối repository GitHub vào **Cloudflare Pages**.
2. Cấu hình Build:
   - **Root directory:** `frontend`
   - **Build command:** `npm run build`
   - **Output directory:** `dist`
3. Thêm Environment Variables trên Cloudflare Pages:
   - `VITE_API_URL=https://api.your-domain.com`
   - `VITE_WS_URL=wss://api.your-domain.com/ws/market`
4. Cập nhật lại `CORS_ALLOWED_ORIGINS` trong `.env` của VPS với domain Cloudflare Pages và khởi động lại `bot-engine.service`.
