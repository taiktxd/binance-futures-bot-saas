# EXTREME — Binance USD-M Futures Automated Trading SaaS

> **DÀNH CHO AI CODING TIẾP NHẬN DỰ ÁN:**
> Trước khi viết hoặc sửa bất kỳ dòng code nào, BẮT BUỘC đọc theo đúng thứ tự 4 file trong `/docs`:
> 1. `/docs/ENGINEERING_STANDARDS.md` (Hiến pháp kỹ thuật Senior & chống mùi AI)
> 2. `/docs/ARCHITECTURE.md` (Kiến trúc tổng thể, 10 bảng SQL, luồng Core Engine & API)
> 3. `/docs/PROGRESS.md` (Những gì đã hoàn thành)
> 4. `/docs/TODO_AND_MISSING.md` (Những gì còn thiếu & danh sách việc cần làm tiếp)

## Kiểm thử trước khi bật Live

- [Checklist kiểm tra Binance Futures Testnet](docs/TESTNET_SMOKE_TEST.md)
- [Kết quả backtest BTCUSDT và ETHUSDT](docs/BACKTEST.md)

## Cấu trúc thư mục chính

- `/backend` — Rust Cargo Workspace (Edition 2021) gồm 4 crates: `common`, `binance`, `engine` (1 chiến lược lõi duy nhất `ExtremeAdaptiveCore`), `api` (Axum HTTP + WS).
- `/frontend-static` — Bản Web EXTREME hoàn chỉnh (`index.html`, `logo.png`, `config.js`, `_redirects`) sẵn sàng upload trực tiếp lên Cloudflare Pages Direct Upload (3 màu `#590907` / `#E8D2B5` / `#A5A79B`, Three.js GLSL Shader).
- `/frontend` — Khung React + Vite + TypeScript (tùy chọn nếu muốn chuyển sang build pipeline GitHub).
- `/docs` — Toàn bộ tài liệu bàn giao đa AI và hướng dẫn deploy (`/docs/DEPLOY_AND_TESTNET_GUIDE.md`).
- `/deploy` — File `bot-engine.service` chạy ngầm 24/7 trên VPS Ubuntu 1 vCPU / 2GB RAM.
- `/.github/workflows/build.yml` — Tự động test & biên dịch binary `bot-server-linux-x86_64` ngoài VPS.
- `supabase_schema.sql` — Schema PostgreSQL 10 bảng đầy đủ cho Supabase Free Tier.
- `.env.example` — Mẫu toàn bộ biến môi trường cho Backend VPS.
