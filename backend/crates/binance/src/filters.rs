use rust_decimal::Decimal;
use rust_decimal_macros::dec;

#[derive(Debug, Clone)]
pub struct SymbolFilter {
    pub symbol: String,
    pub tick_size: Decimal,
    pub step_size: Decimal,
    pub min_qty: Decimal,
}

/// Floors a positive value to the nearest valid multiple of `step` to satisfy
/// Binance Futures PRICE_FILTER (-1111) and LOT_SIZE (-4003) constraints.
pub fn round_to_step(value: Decimal, step: Decimal) -> Decimal {
    if step <= dec!(0) {
        return value;
    }
    let steps = (value / step).floor();
    (steps * step).normalize()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_price_and_quantity_to_exchange_steps() {
        assert_eq!(round_to_step(dec!(64123.789), dec!(0.10)), dec!(64123.7));
        assert_eq!(round_to_step(dec!(0.01589), dec!(0.001)), dec!(0.015));
        assert_eq!(round_to_step(dec!(2650.459), dec!(0.01)), dec!(2650.45));
    }
}
