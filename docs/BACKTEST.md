# Backtest EXTREME — BTCUSDT và ETHUSDT

Dùng nến USDⓈ-M 5 phút và funding rates từ kho dữ liệu Binance, tháng 7 đến tháng 10/2026. Tháng 7 dùng để khởi động chỉ báo. Đọc kết quả tháng 8–9 làm mốc tham chiếu và giữ tháng 10 làm cửa sổ kiểm tra kế tiếp. Cả hai giai đoạn dùng cùng cấu hình, khởi đầu với danh mục trống. [Binance Public Data](https://github.com/binance/binance-public-data)

## Phương pháp

- Dùng trực tiếp chiến lược Rust của engine, tín hiệu tại lúc đóng nến và khớp tại giá mở của nến sau. Mỗi cặp và hồ sơ giao dịch độc lập với vốn mô phỏng 1.000 USDT và danh nghĩa 100 USDT mỗi lệnh.
- SL 1,5%, TP 3,5%, phí taker giả định 0,05% và trượt giá 0,02% cho mỗi lượt. Áp funding lịch sử khi vị thế đang mở, dùng giá mở nến tại mốc funding để ước tính danh nghĩa. Đặt hòa vốn sau khi giá đóng nến đi ít nhất nửa đường tới TP.
- Nếu cùng nến chạm SL và TP, ưu tiên SL. Giá mở vượt qua SL được dùng cho khớp stop trước khi cộng trượt giá. Định giá vốn ở cuối nến và đóng vị thế còn lại ở cuối kỳ. Mô phỏng dựa trên OHLC của hợp đồng, với SL/TP quan sát từ dữ liệu nến thay cho dữ liệu mark price theo tick. Kết quả trước phí SaaS, chưa mô phỏng bước giá/khối lượng của sàn, độ sâu sổ lệnh hoặc thanh lý.

## Kết quả

| Giai đoạn UTC | Cặp | Hồ sơ | Lệnh | Tỷ lệ thắng | Profit factor | PnL ròng (USDT) | Max drawdown |
|---|---|---|---:|---:|---:|---:|---:|
| 01/08–30/09 | BTCUSDT | SAFE | 26 | 30,76% | 1,348 | +6,96 | 1,002% |
| 01/08–30/09 | BTCUSDT | BALANCED | 31 | 22,58% | 0,804 | −5,69 | 1,665% |
| 01/08–30/09 | BTCUSDT | GROWTH | 46 | 21,73% | 0,677 | −14,89 | 3,409% |
| 01/08–30/09 | ETHUSDT | SAFE | 46 | 19,56% | 0,678 | −14,41 | 2,007% |
| 01/08–30/09 | ETHUSDT | BALANCED | 49 | 26,53% | 1,120 | +4,72 | 1,451% |
| 01/08–30/09 | ETHUSDT | GROWTH | 65 | 21,53% | 0,770 | −13,38 | 2,241% |
| 01/10–31/10 | BTCUSDT | SAFE | 12 | 8,33% | 0,251 | −10,02 | 1,244% |
| 01/10–31/10 | BTCUSDT | BALANCED | 16 | 12,50% | 0,490 | −7,00 | 1,075% |
| 01/10–31/10 | BTCUSDT | GROWTH | 22 | 27,27% | 1,020 | +0,35 | 1,411% |
| 01/10–31/10 | ETHUSDT | SAFE | 24 | 29,16% | 0,900 | −2,29 | 0,893% |
| 01/10–31/10 | ETHUSDT | BALANCED | 27 | 33,33% | 1,116 | +2,86 | 0,919% |
| 01/10–31/10 | ETHUSDT | GROWTH | 39 | 30,76% | 1,044 | +1,68 | 1,936% |

ETHUSDT BALANCED có lãi trong cả hai cửa sổ, nhưng lợi nhuận sau chi phí mô phỏng nhỏ và tháng 10 chỉ có 27 lệnh. Giữ `ENABLE_LIVE_TRADING=false` trong khi kiểm tra thêm các giai đoạn thị trường và chênh lệch giữa khớp mô phỏng với khớp Demo.

## Chạy lại

Tải và giải nén các CSV tháng 7–10/2026 từ các đường dẫn dưới đây với `SYMBOL` là BTCUSDT hoặc ETHUSDT, `YYYY-MM` là tháng UTC. Đặt các CSV trong cùng thư mục dữ liệu.

- Nến: `https://data.binance.vision/data/futures/um/monthly/klines/SYMBOL/5m/SYMBOL-5m-YYYY-MM.zip`
- Funding: `https://data.binance.vision/data/futures/um/monthly/fundingRate/SYMBOL/SYMBOL-fundingRate-YYYY-MM.zip`

Chạy trong `backend/` và thay BTCUSDT bằng ETHUSDT để kiểm tra cặp thứ hai. Ngày kết thúc là mốc UTC loại trừ.

```sh
cargo run --locked -p engine --bin backtest -- <csv-dir> BTCUSDT 2026-08-01 2026-10-01
cargo run --locked -p engine --bin backtest -- <csv-dir> BTCUSDT 2026-10-01 2026-11-01
```
