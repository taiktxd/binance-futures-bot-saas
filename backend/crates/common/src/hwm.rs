use crate::models::SubscriptionPlan;
use rust_decimal::Decimal;
use rust_decimal_macros::dec;

pub const F2_HWM_COMMISSION_RATE: Decimal = dec!(0.05);

pub fn f1_hwm_commission_rate(activated_f1_count: i64) -> Decimal {
    if activated_f1_count >= 100 {
        dec!(0.30)
    } else if activated_f1_count >= 30 {
        dec!(0.25)
    } else if activated_f1_count >= 10 {
        dec!(0.20)
    } else {
        dec!(0.15)
    }
}

pub fn f1_subscription_commission_rate(activated_f1_count: i64) -> Decimal {
    if activated_f1_count >= 100 {
        dec!(0.35)
    } else if activated_f1_count >= 30 {
        dec!(0.30)
    } else if activated_f1_count >= 10 {
        dec!(0.25)
    } else {
        dec!(0.20)
    }
}

pub fn partner_tier_name(activated_f1_count: i64) -> &'static str {
    if activated_f1_count >= 100 {
        "Đối tác Kim Cương"
    } else if activated_f1_count >= 30 {
        "Đối tác Vàng"
    } else if activated_f1_count >= 10 {
        "Đối tác Bạc"
    } else {
        "Cộng tác viên"
    }
}

pub const REFERRAL_FIRST_SUB_DISCOUNT_RATE: Decimal = dec!(0.10);

pub fn first_deposit_bonus_usd(base_bonus: Decimal, has_referrer: bool) -> Decimal {
    if has_referrer {
        (base_bonus * dec!(2)).round_dp(8)
    } else {
        base_bonus.round_dp(8)
    }
}

pub fn subscription_plan_price_usd(plan: SubscriptionPlan) -> Option<Decimal> {
    match plan {
        SubscriptionPlan::Standard => Some(dec!(29)),
        SubscriptionPlan::Pro => Some(dec!(79)),
        SubscriptionPlan::Inactive | SubscriptionPlan::Trial => None,
    }
}

pub fn subscription_checkout_price_usd(
    plan: SubscriptionPlan,
    has_referrer: bool,
    is_first_subscription: bool,
) -> Option<Decimal> {
    let base = subscription_plan_price_usd(plan)?;
    if has_referrer && is_first_subscription {
        Some((base * (dec!(1) - REFERRAL_FIRST_SUB_DISCOUNT_RATE)).round_dp(2))
    } else {
        Some(base)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HwmSettlement {
    pub cumulative_net_pnl_after: Decimal,
    pub hwm_before: Decimal,
    pub hwm_after: Decimal,
    pub profit_above_hwm: Decimal,
    pub fee_charged: Decimal,
    pub credit_balance_after: Decimal,
    pub should_stop_new_entries: bool,
}

/// Computes the 20% High-Water Mark profit-sharing settlement using exact Decimal math.
/// When credit_balance_after <= 0, `should_stop_new_entries` is set to true so the caller
/// transitions RUNNING bots to STOP_NEW_ENTRIES without ever force-closing open positions.
pub fn calculate_hwm_settlement(
    credit_balance_before: Decimal,
    cumulative_net_pnl_before: Decimal,
    high_water_mark_before: Decimal,
    realized_pnl: Decimal,
    fee_rate: Decimal,
) -> HwmSettlement {
    let cumulative_after = cumulative_net_pnl_before + realized_pnl;

    let (profit_above_hwm, fee_charged, hwm_after) = if cumulative_after > high_water_mark_before {
        let excess = cumulative_after - high_water_mark_before;
        let fee = (excess * fee_rate).round_dp(8);
        (excess, fee, cumulative_after)
    } else {
        (dec!(0), dec!(0), high_water_mark_before)
    };

    let credit_after = (credit_balance_before - fee_charged).round_dp(8);

    HwmSettlement {
        cumulative_net_pnl_after: cumulative_after.round_dp(8),
        hwm_before: high_water_mark_before,
        hwm_after: hwm_after.round_dp(8),
        profit_above_hwm: profit_above_hwm.round_dp(8),
        fee_charged,
        credit_balance_after: credit_after,
        should_stop_new_entries: credit_after <= dec!(0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn charges_20_percent_only_above_high_water_mark() {
        let rate = dec!(0.20);

        // Trade 1: +100 USDT -> HWM moves 0 -> 100, fee = 20, credit 50 -> 30
        let s1 = calculate_hwm_settlement(dec!(50), dec!(0), dec!(0), dec!(100), rate);
        assert_eq!(s1.fee_charged, dec!(20));
        assert_eq!(s1.hwm_after, dec!(100));
        assert_eq!(s1.credit_balance_after, dec!(30));
        assert!(!s1.should_stop_new_entries);

        // Trade 2: -40 USDT -> cumulative = 60 <= HWM 100, fee = 0
        let s2 = calculate_hwm_settlement(
            s1.credit_balance_after,
            s1.cumulative_net_pnl_after,
            s1.hwm_after,
            dec!(-40),
            rate,
        );
        assert_eq!(s2.fee_charged, dec!(0));
        assert_eq!(s2.hwm_after, dec!(100));
        assert_eq!(s2.credit_balance_after, dec!(30));

        // Trade 3: +30 USDT -> cumulative = 90 <= HWM 100, still recovering, fee = 0
        let s3 = calculate_hwm_settlement(
            s2.credit_balance_after,
            s2.cumulative_net_pnl_after,
            s2.hwm_after,
            dec!(30),
            rate,
        );
        assert_eq!(s3.fee_charged, dec!(0));
        assert_eq!(s3.hwm_after, dec!(100));

        // Trade 4: +60 USDT -> cumulative = 150 > HWM 100, excess = 50, fee = 10
        let s4 = calculate_hwm_settlement(
            s3.credit_balance_after,
            s3.cumulative_net_pnl_after,
            s3.hwm_after,
            dec!(60),
            rate,
        );
        assert_eq!(s4.profit_above_hwm, dec!(50));
        assert_eq!(s4.fee_charged, dec!(10));
        assert_eq!(s4.hwm_after, dec!(150));
        assert_eq!(s4.credit_balance_after, dec!(20));
    }

    #[test]
    fn triggers_stop_new_entries_when_credit_reaches_zero_or_below() {
        let s = calculate_hwm_settlement(dec!(5), dec!(0), dec!(0), dec!(30), dec!(0.20));
        assert_eq!(s.fee_charged, dec!(6));
        assert_eq!(s.credit_balance_after, dec!(-1));
        assert!(s.should_stop_new_entries);
    }

    #[test]
    fn partner_commission_tiers_match_schedule() {
        assert_eq!(f1_hwm_commission_rate(0), dec!(0.15));
        assert_eq!(f1_hwm_commission_rate(9), dec!(0.15));
        assert_eq!(f1_hwm_commission_rate(10), dec!(0.20));
        assert_eq!(f1_hwm_commission_rate(29), dec!(0.20));
        assert_eq!(f1_hwm_commission_rate(30), dec!(0.25));
        assert_eq!(f1_hwm_commission_rate(99), dec!(0.25));
        assert_eq!(f1_hwm_commission_rate(100), dec!(0.30));

        assert_eq!(f1_subscription_commission_rate(0), dec!(0.20));
        assert_eq!(f1_subscription_commission_rate(10), dec!(0.25));
        assert_eq!(f1_subscription_commission_rate(30), dec!(0.30));
        assert_eq!(f1_subscription_commission_rate(100), dec!(0.35));
        assert_eq!(F2_HWM_COMMISSION_RATE, dec!(0.05));
    }

    #[test]
    fn subscription_plan_prices_only_allow_paid_tiers() {
        assert_eq!(
            subscription_plan_price_usd(SubscriptionPlan::Inactive),
            None
        );
        assert_eq!(subscription_plan_price_usd(SubscriptionPlan::Trial), None);
        assert_eq!(
            subscription_plan_price_usd(SubscriptionPlan::Standard),
            Some(dec!(29))
        );
        assert_eq!(
            subscription_plan_price_usd(SubscriptionPlan::Pro),
            Some(dec!(79))
        );
    }

    #[test]
    fn referral_invitee_perks_double_bonus_and_discount_first_subscription() {
        assert_eq!(first_deposit_bonus_usd(dec!(5), false), dec!(5));
        assert_eq!(first_deposit_bonus_usd(dec!(5), true), dec!(10));

        assert_eq!(
            subscription_checkout_price_usd(SubscriptionPlan::Standard, true, true),
            Some(dec!(26.10))
        );
        assert_eq!(
            subscription_checkout_price_usd(SubscriptionPlan::Pro, true, true),
            Some(dec!(71.10))
        );
        assert_eq!(
            subscription_checkout_price_usd(SubscriptionPlan::Standard, true, false),
            Some(dec!(29))
        );
        assert_eq!(
            subscription_checkout_price_usd(SubscriptionPlan::Pro, false, true),
            Some(dec!(79))
        );
    }
}
