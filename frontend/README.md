# Frontend (Three.js + React/Vite hoặc Next.js + Tailwind CSS)

Thư mục này được khởi tạo giữ chỗ ở **Phase 1** và sẽ được dựng hoàn chỉnh ở **Phase 5**, deploy tách biệt lên **Cloudflare Pages** hoặc **Vercel**.

Các trang bắt buộc:
- `/` — Landing Page 3D (BTC, ETH, GOLD/XAU)
- `/login` & `/register` — Đăng ký nhận ngay $5.00 Bonus Credit
- `/dashboard` — 3D Live Market Core + Tổng quan Credit, PnL, HWM, Vị thế mở
- `/api-keys` — Kết nối API Binance Futures (Testnet/Live), hiển thị `SERVER_STATIC_IP`, nút Test Connection
- `/bots` — Cấu hình Bot (BTCUSDT / ETHUSDT / XAUUSDT), đòn bẩy (<=20x), ISOLATED/CROSSED, Start/Stop
- `/trades` — Lịch sử lệnh Futures Long/Short, Realized PnL, Phí HWM
- `/wallet` — Số dư Credit, sao kê trừ phí 20% HWM minh bạch, nạp VietQR / USDT BEP20
- `/admin` — Quản trị user, cộng/trừ Credit thủ công, theo dõi Rust Engine
