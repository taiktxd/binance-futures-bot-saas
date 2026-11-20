# TIÊU CHUẨN KỸ THUẬT SENIOR & CHỐNG "MÙI AI" (ENGINEERING STANDARDS)

> **Hiệu lực:** Hiến pháp kỹ thuật bắt buộc cho toàn bộ mã nguồn Rust Backend, Trading Engine, SQL và Frontend Three.js của dự án. Mọi AI hoặc kỹ sư tham gia viết/sửa code phải tuân thủ nghiêm ngặt 100% trước khi bàn giao.

---

## PHẦN 1: QUY TẮC TRIỆT TIÊU LỖI KHI AI CODE (ZERO-BUG & PRODUCTION-GRADE)

### 1. Cấm bịa đặt (No Hallucination)
- Chỉ sử dụng các crate, module, hàm và phiên bản **có thật** đã được khai báo trong `backend/Cargo.toml` và `frontend/package.json`.
- Nếu không chắc chắn 100% về chữ ký hàm (function signature) hoặc API của một thư viện phiên bản mới, bắt buộc ghi rõ vào mục cần kiểm tra trong `/docs/PROGRESS.md` — **tuyệt đối không tự đoán mò**.

### 2. Cấm code nửa vời & dữ liệu giả (No Placeholders)
- Cấm tuyệt đối các đoạn giữ chỗ: `// TODO: implement later`, `todo!()`, `unimplemented!()`, `// ... rest of the code`, hoặc trả về mock data rồi báo đã hoàn thành.
- Mọi hàm viết ra phải chạy trọn vẹn logic thực tế từ đầu đến cuối.

### 3. Luật thép cho Rust (Backend & Trading Engine)
- **Không panic ở production:** Cấm dùng `.unwrap()` và `.expect()` trong toàn bộ code production (chỉ được phép dùng trong khối `#[cfg(test)]`). Mọi lỗi phải trả về tường minh qua `Result<T, E>` (dùng `thiserror` cho lỗi domain, `anyhow` ở tầng ứng dụng).
- **Toán học tài chính chính xác tuyệt đối:** Cấm dùng `f64` / `f32` cho tiền tệ, giá, khối lượng, PnL, Credit, tỷ lệ 20% HWM. Bắt buộc dùng `rust_decimal::Decimal`.
- **Xử lý triệt để đặc thù sàn Binance USDⓈ-M Futures:**
  - Tự động làm tròn khối lượng và giá theo `stepSize` và `tickSize` từ `/fapi/v1/exchangeInfo` cho từng cặp (`BTCUSDT`, `ETHUSDT`, `XAUUSDT`/`PAXGUSDT`) để tránh lỗi `-1111` hoặc `-4003`.
  - Xử lý lệch đồng hồ server bằng `recvWindow` và cơ chế đồng bộ server time (`/fapi/v1/time`) để tránh lỗi `-1021`.
  - Xử lý Rate Limit (`HTTP 429` / `418`) bằng backoff có kiểm soát; không spam request.
  - WebSocket bắt buộc có Ping/Pong keep-alive, tự động reconnect theo Exponential Backoff khi rớt mạng, và đồng bộ lại trạng thái vị thế sau khi kết nối lại.
- **An toàn bất đồng bộ (Tokio):** Không giữ `MutexGuard` hoặc `RwLockGuard` xuyên qua điểm `.await` để tránh deadlock.

### 4. Luật thép cho Three.js & Frontend
- **Quản lý bộ nhớ WebGL (VRAM):** Mọi `Geometry`, `Material`, `Texture`, `Renderer` tạo thủ công bắt buộc phải gọi `.dispose()` trong hàm cleanup của `useEffect` để tránh rò rỉ VRAM khi mở tab lâu.
- **Tối ưu vòng lặp render (60FPS):** Không cấp phát object mới (`new THREE.Vector3()`, `new THREE.Color()`, v.v.) bên trong `useFrame` hoặc `requestAnimationFrame` (tránh giật khung hình do Garbage Collector).
- **Cấu hình môi trường:** Không hardcode `http://localhost:...` trong mã nguồn; bắt buộc đọc từ biến môi trường (`NEXT_PUBLIC_API_URL` hoặc `VITE_API_URL`).
- **Trạng thái giao diện đầy đủ:** Mọi lệnh gọi API bắt buộc xử lý đủ 3 trạng thái: `loading`, `error` (thông báo rõ nguyên nhân), và `empty` (chưa có lệnh / chưa kết nối API).

---

## PHẦN 2: QUY TẮC XÓA SẠCH "DẤU VÂN TAY AI" (ANTI-AI-SLOP)

### 1. Comment như Senior Engineer thực thụ
- **Cấm comment giải thích CÁI GÌ (WHAT)** mà đọc code đã rõ:
  - Sai: `// Tính tổng lợi nhuận` trên dòng `let total_pnl = a + b;`
  - Sai: `// Import thư viện cần thiết` hoặc `// Kết nối database`
- **Chỉ comment giải thích TẠI SAO (WHY)** ở các đoạn nghiệp vụ nhạy cảm hoặc ràng buộc khó thấy (ví dụ: tại sao không force close vị thế khi `credit_balance <= 0`, tại sao mặc định `ISOLATED` margin, giải thích điểm chốt HWM).
- **Cấm văn nói AI trong code:** Tuyệt đối không để lại các câu kiểu `// Here we update...`, `// Updated as requested`, `// Note: You can customize this`.

### 2. Cấm spam Emoji
- Tuyệt đối không dùng emoji trong:
  - Log hệ thống Rust (sử dụng structured logging của `tracing`: `info!`, `warn!`, `error!` kèm cặp `key = value` rõ ràng).
  - Comment trong mã nguồn.
  - Giao diện Web (thay hoàn toàn bằng bộ icon vector đơn sắc như `lucide-react`).

### 3. Thiết kế UI/UX & Three.js theo chuẩn Institutional Trading Terminal
- **Cấm phong cách AI rập khuôn:**
  - Cấm nền gradient tím-hồng-xanh neon lòe loẹt vô nghĩa.
  - Cấm lạm dụng glassmorphism và viền glow quá đà làm giảm độ tương phản chữ.
  - Cấm copywriting quảng cáo sáo rỗng ("Unlock the future of trading", "Revolutionize your wealth", "Next-gen AI-powered...").
- **Chuẩn thiết kế bắt buộc (phong cách Bloomberg / Hyperliquid / Bybit Pro):**
  - Bảng màu tối trung tính, độ tương phản cao:
    - Nền chính (Background): `#0A0B0D`
    - Bề mặt thẻ/bảng (Surface): `#121418`
    - Viền mảnh (Border): `1px solid #22262E`
    - Tăng / Long (Bullish): `#16C784`
    - Giảm / Short (Bearish): `#EA3943`
    - Điểm nhấn Vàng kim (XAU / Gold): `#D4AF37`
  - Mọi con số giá, PnL, Credit, đòn bẩy bắt buộc dùng font monospace hoặc `font-variant-numeric: tabular-nums` để không nhảy cột khi cập nhật real-time.
  - Cảnh 3D Three.js tối giản, chuyển động mượt phản hồi trực tiếp theo dữ liệu thị trường thực, không gây rối khu vực đặt lệnh và nút thao tác.

### 4. Cấu trúc code tự nhiên, không Over-Engineering
- Không tạo tầng trừu tượng thừa (`Trait`, `Factory`, `Wrapper` rỗng) cho các hàm chỉ dùng một lần.
- Đặt tên biến, hàm ngắn gọn, chuẩn thuật ngữ tài chính: `hwm`, `realized_pnl`, `margin_mode`, `entry_price`, `mark_price`, `tick_size`, `step_size`.

---

## PHẦN 3: QUY TRÌNH TỰ KIỂM TRA TRƯỚC KHI TRẢ CODE (SELF-AUDIT CHECKLIST)

Trước khi kết thúc bất kỳ phiên code nào, bắt buộc rà soát và xác nhận đủ 5 tiêu chí:

1. [ ] Đã loại bỏ 100% `.unwrap()`, `.expect()`, `todo!()`, `unimplemented!()`, và `f64`/`f32` trong tính toán tài chính chưa?
2. [ ] Toàn bộ đường dẫn `import`/`use`, tên bảng và tên cột SQL có khớp 100% với `/docs/ARCHITECTURE.md` và `supabase_schema.sql` không?
3. [ ] Đã xóa sạch comment thừa thãi, văn nói AI và mọi emoji trong code, log, UI chưa?
4. [ ] Mọi tài nguyên Three.js tạo thủ công đã có cleanup `.dispose()` và không cấp phát object trong vòng lặp render chưa?
5. [ ] Đã cập nhật đầy đủ `/docs/PROGRESS.md` và `/docs/TODO_AND_MISSING.md` theo đúng 3 mục chuẩn bàn giao đa AI chưa?

---

## PHẦN 4: QUY TẮC ÁP DỤNG & BÀN GIAO ĐA AI

- File này là **tài liệu ưu tiên đọc đầu tiên** cùng với `/docs/ARCHITECTURE.md` trước mọi thao tác code ở tất cả các Phase (Phase 2 -> Phase 6).
- Nếu một yêu cầu kỹ thuật mới phát sinh mâu thuẫn với quy tắc tại đây (ví dụ: phải dùng `f64` tạm cho đầu vào chỉ báo kỹ thuật của crate `ta`), phải chuyển đổi cục bộ tại ranh giới chỉ báo và tuyệt đối không để `f64` lọt sang tầng tính toán khối lượng, giá đặt lệnh, PnL hoặc Credit.
