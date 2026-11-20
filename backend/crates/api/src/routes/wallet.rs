use crate::auth_mw::AuthUser;
use crate::state::{ApiError, ApiResult, AppState};
use axum::{extract::State, http::HeaderMap, Json};
use chrono::{DateTime, Duration, Utc};
use common::{
    f1_hwm_commission_rate, f1_subscription_commission_rate, first_deposit_bonus_usd,
    partner_tier_name, subscription_checkout_price_usd, subscription_plan_price_usd, AppError,
    CreditTransactionRecord, CreditTxType, DepositOrderRecord, NotificationRecord,
    SubscriptionPlan, UserRecord, WithdrawMethod, WithdrawRequestRecord, F2_HWM_COMMISSION_RATE,
};
use hmac::{Hmac, Mac};
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use serde::{Deserialize, Serialize};
use sha2::Sha512;
use sqlx::Row;
use tracing::{info, warn};
use uuid::Uuid;

type HmacSha512 = Hmac<Sha512>;

#[derive(Deserialize)]
pub struct CreateDepositRequest {
    pub credit_usd_amount: Decimal,
}

#[derive(Serialize)]
pub struct VietQrDepositResponse {
    pub order: DepositOrderRecord,
    pub bank_bin: String,
    pub account_no: String,
    pub account_name: String,
    pub amount_vnd: Decimal,
    pub qr_url: String,
}

#[derive(Deserialize)]
pub struct SepayWebhookPayload {
    pub id: serde_json::Value,
    pub content: String,
    #[serde(rename = "transferAmount")]
    pub transfer_amount: Decimal,
    #[serde(rename = "transferType")]
    pub transfer_type: String,
}

#[derive(Deserialize)]
pub struct CreateWithdrawRequest {
    pub method: WithdrawMethod,
    pub amount_usd: Decimal,
    pub vnd_rate: Option<Decimal>,
    pub bsc20_address: Option<String>,
    pub bank_name: Option<String>,
    pub bank_account_no: Option<String>,
    pub bank_account_holder: Option<String>,
}

#[derive(Deserialize)]
pub struct SubscribePlanRequest {
    pub plan: SubscriptionPlan,
}

#[derive(Serialize)]
pub struct EarnSummaryResponse {
    pub referral_code: String,
    pub commission_balance: Decimal,
    pub active_f1_count: i64,
    pub total_f1_count: i64,
    pub tier_name: &'static str,
    pub sub_rate_pct: Decimal,
    pub hwm_rate_pct: Decimal,
    pub f2_rate_pct: Decimal,
}

pub async fn list_wallet_transactions(
    State(state): State<AppState>,
    auth: AuthUser,
) -> ApiResult<Json<Vec<CreditTransactionRecord>>> {
    let rows = sqlx::query_as::<_, CreditTransactionRecord>(
        "SELECT * FROM credit_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100",
    )
    .bind(auth.user_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

pub async fn create_vietqr_deposit(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(payload): Json<CreateDepositRequest>,
) -> ApiResult<Json<VietQrDepositResponse>> {
    if payload.credit_usd_amount < dec!(1) {
        return Err(ApiError(AppError::Validation(
            "minimum deposit amount is $1.00 USD".to_string(),
        )));
    }

    let amount_vnd =
        (payload.credit_usd_amount * state.config.vnd_to_usd_exchange_rate).round_dp(0);
    let short_id = &Uuid::new_v4().simple().to_string()[..8].to_uppercase();
    let order_code = format!("EX{short_id}");

    let order = sqlx::query_as::<_, DepositOrderRecord>(
        r#"
        INSERT INTO deposit_orders (
            user_id, provider, order_code, pay_amount, pay_currency, credit_usd_amount, status
        )
        VALUES ($1, 'SEPAY_VIETQR', $2, $3, 'VND', $4, 'PENDING')
        RETURNING *
        "#,
    )
    .bind(auth.user_id)
    .bind(&order_code)
    .bind(amount_vnd)
    .bind(payload.credit_usd_amount)
    .fetch_one(&state.pool)
    .await?;

    let qr_url = format!(
        "https://img.vietqr.io/image/{}-{}-compact2.png?amount={}&addInfo={}",
        state.config.vietqr_bank_bin, state.config.vietqr_account_no, amount_vnd, order_code
    );

    Ok(Json(VietQrDepositResponse {
        order,
        bank_bin: state.config.vietqr_bank_bin.clone(),
        account_no: state.config.vietqr_account_no.clone(),
        account_name: state.config.vietqr_account_name.clone(),
        amount_vnd,
        qr_url,
    }))
}

pub async fn create_crypto_deposit(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(payload): Json<CreateDepositRequest>,
) -> ApiResult<Json<DepositOrderRecord>> {
    if payload.credit_usd_amount < dec!(1) {
        return Err(ApiError(AppError::Validation(
            "minimum USDT BEP20 deposit is $1.00".to_string(),
        )));
    }

    let short_id = &Uuid::new_v4().simple().to_string()[..8].to_uppercase();
    let order_code = format!("EXUSDT{short_id}");

    let order = sqlx::query_as::<_, DepositOrderRecord>(
        r#"
        INSERT INTO deposit_orders (
            user_id, provider, order_code, pay_amount, pay_currency, credit_usd_amount, status
        )
        VALUES ($1, 'NOWPAYMENTS_USDT_BEP20', $2, $3, 'USDTBSC', $3, 'PENDING')
        RETURNING *
        "#,
    )
    .bind(auth.user_id)
    .bind(&order_code)
    .bind(payload.credit_usd_amount)
    .fetch_one(&state.pool)
    .await?;

    Ok(Json(order))
}

pub async fn subscribe_plan(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(payload): Json<SubscribePlanRequest>,
) -> ApiResult<Json<UserRecord>> {
    let list_price = subscription_plan_price_usd(payload.plan).ok_or_else(|| {
        AppError::Validation("only STANDARD ($29) or PRO ($79) plans can be subscribed".to_string())
    })?;

    let mut tx = state.pool.begin().await?;
    let row = sqlx::query(
        r#"
        SELECT credit_balance, plan_expires_at, referred_by_user_id
        FROM users
        WHERE id = $1
        FOR UPDATE
        "#,
    )
    .bind(auth.user_id)
    .fetch_one(&mut *tx)
    .await?;

    let before: Decimal = row.try_get("credit_balance")?;
    let existing_expires: Option<DateTime<Utc>> = row.try_get("plan_expires_at")?;
    let referred_by_user_id: Option<Uuid> = row.try_get("referred_by_user_id")?;

    let prior_sub_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM credit_transactions WHERE user_id = $1 AND tx_type = 'SUBSCRIPTION_FEE'",
    )
    .bind(auth.user_id)
    .fetch_one(&mut *tx)
    .await?;

    let has_referrer = referred_by_user_id.is_some();
    let is_first_sub = prior_sub_count == 0;
    let discount_applied = has_referrer && is_first_sub;
    let price = subscription_checkout_price_usd(payload.plan, has_referrer, is_first_sub)
        .unwrap_or(list_price);

    if before < price {
        return Err(ApiError(AppError::Forbidden(format!(
            "insufficient credit balance: need ${:.2}, available ${:.2}",
            price, before
        ))));
    }

    let after = (before - price).round_dp(8);
    let now = Utc::now();
    let base_time = existing_expires.filter(|t| *t > now).unwrap_or(now);
    let new_expires = base_time + Duration::days(30);

    let updated_user = sqlx::query_as::<_, UserRecord>(
        r#"
        UPDATE users
        SET credit_balance = $1,
            plan = $2,
            plan_expires_at = $3
        WHERE id = $4
        RETURNING *
        "#,
    )
    .bind(after)
    .bind(payload.plan)
    .bind(new_expires)
    .bind(auth.user_id)
    .fetch_one(&mut *tx)
    .await?;

    let plan_label = match payload.plan {
        SubscriptionPlan::Standard => {
            if discount_applied {
                "STANDARD ($26.10 — giảm 10% mã giới thiệu)"
            } else {
                "STANDARD ($29/tháng)"
            }
        }
        SubscriptionPlan::Pro => {
            if discount_applied {
                "PRO ($71.10 — giảm 10% mã giới thiệu)"
            } else {
                "PRO ($79/tháng)"
            }
        }
        _ => "SUBSCRIPTION",
    };

    sqlx::query(
        r#"
        INSERT INTO credit_transactions (
            user_id, tx_type, amount, balance_before, balance_after, note, metadata
        )
        VALUES ($1, 'SUBSCRIPTION_FEE', $2, $3, $4, $5, $6)
        "#,
    )
    .bind(auth.user_id)
    .bind(-price)
    .bind(before)
    .bind(after)
    .bind(format!("Đăng ký gói {plan_label}"))
    .bind(serde_json::json!({
        "plan": payload.plan,
        "list_price": list_price.to_string(),
        "final_price": price.to_string(),
        "referral_discount_pct": if discount_applied { 10 } else { 0 },
        "expires_at": new_expires.to_rfc3339()
    }))
    .execute(&mut *tx)
    .await?;

    sqlx::query("INSERT INTO notifications (user_id, title, body) VALUES ($1, $2, $3)")
        .bind(auth.user_id)
        .bind("Nâng cấp gói thuê bao thành công")
        .bind(format!(
            "Đã kích hoạt gói {plan_label} (hiệu lực 30 ngày). Số dư Credit còn lại: ${:.2}.",
            after
        ))
        .execute(&mut *tx)
        .await?;

    if let Some(f1_id) = referred_by_user_id.filter(|id| *id != auth.user_id) {
        let active_f1_count: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*) FROM users
            WHERE referred_by_user_id = $1
              AND is_active = TRUE
              AND (bonus_credit_granted = TRUE OR plan <> 'INACTIVE')
            "#,
        )
        .bind(f1_id)
        .fetch_one(&mut *tx)
        .await?;

        let sub_rate = f1_subscription_commission_rate(active_f1_count);
        let f1_commission = (price * sub_rate).round_dp(8);
        if f1_commission > dec!(0) {
            let updated = sqlx::query(
                "UPDATE users SET commission_balance = commission_balance + $1 WHERE id = $2",
            )
            .bind(f1_commission)
            .bind(f1_id)
            .execute(&mut *tx)
            .await?
            .rows_affected();

            if updated > 0 {
                let rate_pct = (sub_rate * dec!(100)).round_dp(0);
                sqlx::query("INSERT INTO notifications (user_id, title, body) VALUES ($1, $2, $3)")
                    .bind(f1_id)
                    .bind("Hoa hồng gói thuê bao F1")
                    .bind(format!(
                        "Bạn nhận được ${:.2} hoa hồng ({}% từ gói {plan_label} của khách F1).",
                        f1_commission, rate_pct
                    ))
                    .execute(&mut *tx)
                    .await?;
            }
        }
    }

    tx.commit().await?;
    Ok(Json(updated_user))
}

pub async fn earn_summary(
    State(state): State<AppState>,
    auth: AuthUser,
) -> ApiResult<Json<EarnSummaryResponse>> {
    let row = sqlx::query("SELECT referral_code, commission_balance FROM users WHERE id = $1")
        .bind(auth.user_id)
        .fetch_one(&state.pool)
        .await?;
    let referral_code: String = row.try_get("referral_code")?;
    let commission_balance: Decimal = row.try_get("commission_balance")?;

    let total_f1_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE referred_by_user_id = $1")
            .bind(auth.user_id)
            .fetch_one(&state.pool)
            .await?;

    let active_f1_count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*) FROM users
        WHERE referred_by_user_id = $1
          AND is_active = TRUE
          AND (bonus_credit_granted = TRUE OR plan <> 'INACTIVE')
        "#,
    )
    .bind(auth.user_id)
    .fetch_one(&state.pool)
    .await?;

    Ok(Json(EarnSummaryResponse {
        referral_code,
        commission_balance,
        active_f1_count,
        total_f1_count,
        tier_name: partner_tier_name(active_f1_count),
        sub_rate_pct: (f1_subscription_commission_rate(active_f1_count) * dec!(100)).round_dp(0),
        hwm_rate_pct: (f1_hwm_commission_rate(active_f1_count) * dec!(100)).round_dp(0),
        f2_rate_pct: (F2_HWM_COMMISSION_RATE * dec!(100)).round_dp(0),
    }))
}

pub async fn list_withdraw_requests(
    State(state): State<AppState>,
    auth: AuthUser,
) -> ApiResult<Json<Vec<WithdrawRequestRecord>>> {
    let rows = sqlx::query_as::<_, WithdrawRequestRecord>(
        "SELECT * FROM withdraw_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50",
    )
    .bind(auth.user_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

/// Submits a partner commission withdrawal request capped at $5.00 per order.
/// Supports Bank (auto-converted to VND) and BSC20 (USDT), with 24h business approval notice.
pub async fn create_withdraw_request(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(payload): Json<CreateWithdrawRequest>,
) -> ApiResult<Json<WithdrawRequestRecord>> {
    if payload.amount_usd <= dec!(0) || payload.amount_usd > dec!(5) {
        return Err(ApiError(AppError::Validation(
            "withdrawal amount must be > $0 and at most $5.00 per order".to_string(),
        )));
    }

    let (rate_snap, amount_vnd) = match payload.method {
        WithdrawMethod::Bank => {
            if payload.bank_name.as_deref().unwrap_or("").trim().is_empty()
                || payload
                    .bank_account_no
                    .as_deref()
                    .unwrap_or("")
                    .trim()
                    .is_empty()
                || payload
                    .bank_account_holder
                    .as_deref()
                    .unwrap_or("")
                    .trim()
                    .is_empty()
            {
                return Err(ApiError(AppError::Validation(
                    "bank_name, bank_account_no, and bank_account_holder are required for BANK withdrawal".to_string(),
                )));
            }
            let rate = payload
                .vnd_rate
                .unwrap_or(state.config.vnd_to_usd_exchange_rate);
            (Some(rate), Some((payload.amount_usd * rate).round_dp(0)))
        }
        WithdrawMethod::Bsc20 => {
            if payload.bsc20_address.as_deref().unwrap_or("").trim().len() < 6 {
                return Err(ApiError(AppError::Validation(
                    "valid BSC20 address or ID is required".to_string(),
                )));
            }
            (None, None)
        }
    };

    let mut tx = state.pool.begin().await?;
    let row = sqlx::query("SELECT commission_balance FROM users WHERE id = $1 FOR UPDATE")
        .bind(auth.user_id)
        .fetch_one(&mut *tx)
        .await?;
    let comm_bal: Decimal = row.try_get("commission_balance")?;
    if comm_bal < payload.amount_usd {
        return Err(ApiError(AppError::Forbidden(
            "insufficient partner commission balance".to_string(),
        )));
    }

    sqlx::query("UPDATE users SET commission_balance = commission_balance - $1 WHERE id = $2")
        .bind(payload.amount_usd)
        .bind(auth.user_id)
        .execute(&mut *tx)
        .await?;

    let rec = sqlx::query_as::<_, WithdrawRequestRecord>(
        r#"
        INSERT INTO withdraw_requests (
            user_id, method, amount_usd, vnd_rate_snapshot, amount_vnd,
            bsc20_address, bank_name, bank_account_no, bank_account_holder, status
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING')
        RETURNING *
        "#,
    )
    .bind(auth.user_id)
    .bind(payload.method)
    .bind(payload.amount_usd)
    .bind(rate_snap)
    .bind(amount_vnd)
    .bind(payload.bsc20_address)
    .bind(payload.bank_name)
    .bind(payload.bank_account_no)
    .bind(payload.bank_account_holder)
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO notifications (user_id, title, body)
        VALUES ($1, 'Đã tiếp nhận yêu cầu rút tiền', $2)
        "#,
    )
    .bind(auth.user_id)
    .bind(format!(
        "Yêu cầu rút ${:.2} đang chờ đối soát. Cam kết duyệt và giải ngân trong 24h làm việc.",
        payload.amount_usd
    ))
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(Json(rec))
}

pub async fn list_notifications(
    State(state): State<AppState>,
    auth: AuthUser,
) -> ApiResult<Json<Vec<NotificationRecord>>> {
    let items = sqlx::query_as::<_, NotificationRecord>(
        "SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30",
    )
    .bind(auth.user_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(items))
}

pub async fn mark_notifications_read(
    State(state): State<AppState>,
    auth: AuthUser,
) -> ApiResult<Json<serde_json::Value>> {
    sqlx::query("UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE")
        .bind(auth.user_id)
        .execute(&state.pool)
        .await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn sepay_webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<SepayWebhookPayload>,
) -> ApiResult<Json<serde_json::Value>> {
    let expected = format!("Apikey {}", state.config.sepay_webhook_api_key);
    let provided = headers
        .get("Authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if state.config.sepay_webhook_api_key.is_empty() || provided != expected {
        return Err(ApiError(AppError::Unauthorized(
            "invalid SePay webhook API key".to_string(),
        )));
    }

    if payload.transfer_type.to_lowercase() != "in" || payload.transfer_amount <= dec!(0) {
        return Ok(Json(serde_json::json!({ "ignored": true })));
    }

    let external_tx_id = format!("SEPAY-{}", payload.id);
    let content_upper = payload.content.to_uppercase();

    let order = sqlx::query_as::<_, DepositOrderRecord>(
        r#"
        SELECT * FROM deposit_orders
        WHERE status = 'PENDING' AND provider = 'SEPAY_VIETQR'
          AND $1 LIKE '%' || order_code || '%'
        ORDER BY created_at DESC
        LIMIT 1
        "#,
    )
    .bind(&content_upper)
    .fetch_optional(&state.pool)
    .await?;

    let Some(order) = order else {
        warn!(content = %payload.content, "sepay webhook received without matching pending order");
        return Ok(Json(serde_json::json!({ "matched": false })));
    };

    let credit_usd = (payload.transfer_amount / state.config.vnd_to_usd_exchange_rate).round_dp(4);
    apply_deposit_credit(
        &state,
        order.id,
        order.user_id,
        credit_usd,
        CreditTxType::DepositVietqr,
        &external_tx_id,
        serde_json::json!({ "transfer_amount_vnd": payload.transfer_amount.to_string() }),
    )
    .await?;

    Ok(Json(
        serde_json::json!({ "success": true, "credited_usd": credit_usd }),
    ))
}

pub async fn nowpayments_webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: String,
) -> ApiResult<Json<serde_json::Value>> {
    let sig = headers
        .get("x-nowpayments-sig")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| AppError::Unauthorized("missing x-nowpayments-sig header".to_string()))?;

    let mut mac = HmacSha512::new_from_slice(state.config.nowpayments_ipn_secret.as_bytes())
        .map_err(|e| AppError::Crypto(format!("HMAC-SHA512 init failed: {e}")))?;
    mac.update(body.as_bytes());
    let computed = hex::encode(mac.finalize().into_bytes());

    if computed != sig.to_lowercase() {
        return Err(ApiError(AppError::Unauthorized(
            "invalid NOWPayments IPN signature".to_string(),
        )));
    }

    let val: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| AppError::Validation(format!("invalid JSON body: {e}")))?;
    let status = val
        .get("payment_status")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if status != "finished" && status != "confirmed" {
        return Ok(Json(serde_json::json!({ "ignored_status": status })));
    }

    let order_code = val
        .get("order_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Validation("missing order_id".to_string()))?;
    let payment_id = val
        .get("payment_id")
        .map(|v| v.to_string())
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let order = sqlx::query_as::<_, DepositOrderRecord>(
        "SELECT * FROM deposit_orders WHERE order_code = $1 AND status = 'PENDING'",
    )
    .bind(order_code)
    .fetch_optional(&state.pool)
    .await?;

    let Some(order) = order else {
        return Ok(Json(serde_json::json!({ "matched": false })));
    };

    let external_tx_id = format!("NOWPAY-{payment_id}");
    apply_deposit_credit(
        &state,
        order.id,
        order.user_id,
        order.credit_usd_amount,
        CreditTxType::DepositCrypto,
        &external_tx_id,
        val,
    )
    .await?;

    Ok(Json(serde_json::json!({ "success": true })))
}

/// Credits user balance idempotently and grants the one-time promotional bonus
/// when a new account completes its first verified deposit >= $1.00:
/// $5.00 standard, or $10.00 (2x) when the account registered with a referral code.
async fn apply_deposit_credit(
    state: &AppState,
    order_id: Uuid,
    user_id: Uuid,
    credit_usd: Decimal,
    tx_type: CreditTxType,
    external_tx_id: &str,
    raw_payload: serde_json::Value,
) -> Result<(), AppError> {
    let mut tx = state.pool.begin().await?;

    let dup: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM credit_transactions WHERE external_tx_id = $1")
            .bind(external_tx_id)
            .fetch_one(&mut *tx)
            .await?;
    if dup > 0 {
        tx.rollback().await?;
        return Ok(());
    }

    let row = sqlx::query(
        "SELECT credit_balance, bonus_credit_granted, referred_by_user_id FROM users WHERE id = $1 FOR UPDATE",
    )
    .bind(user_id)
    .fetch_one(&mut *tx)
    .await?;
    let before: Decimal = row.try_get("credit_balance")?;
    let bonus_granted: bool = row.try_get("bonus_credit_granted")?;
    let referred_by_user_id: Option<Uuid> = row.try_get("referred_by_user_id")?;

    let has_referrer = referred_by_user_id.is_some();
    let after_deposit = (before + credit_usd).round_dp(8);
    let grant_bonus_now = !bonus_granted && credit_usd >= dec!(1);
    let bonus_amount = if grant_bonus_now {
        first_deposit_bonus_usd(state.config.signup_bonus_credit_usd, has_referrer)
    } else {
        dec!(0)
    };
    let final_balance = (after_deposit + bonus_amount).round_dp(8);

    sqlx::query(
        r#"
        UPDATE users
        SET credit_balance = $1,
            bonus_credit_granted = CASE WHEN $2 THEN TRUE ELSE bonus_credit_granted END,
            plan = CASE WHEN $2 AND plan = 'INACTIVE' THEN 'TRIAL' ELSE plan END,
            low_credit_alert_sent = CASE WHEN $1 >= $3 THEN FALSE ELSE low_credit_alert_sent END,
            zero_credit_alert_sent = CASE WHEN $1 > 0 THEN FALSE ELSE zero_credit_alert_sent END
        WHERE id = $4
        "#,
    )
    .bind(final_balance)
    .bind(grant_bonus_now)
    .bind(state.config.low_credit_alert_threshold_usd)
    .bind(user_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        UPDATE deposit_orders
        SET status = 'PAID', external_payment_id = $1, raw_webhook_payload = $2, paid_at = NOW()
        WHERE id = $3
        "#,
    )
    .bind(external_tx_id)
    .bind(&raw_payload)
    .bind(order_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO credit_transactions (
            user_id, tx_type, amount, balance_before, balance_after, external_tx_id, note, metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'Automated credit deposit', $7)
        "#,
    )
    .bind(user_id)
    .bind(tx_type)
    .bind(credit_usd)
    .bind(before)
    .bind(after_deposit)
    .bind(external_tx_id)
    .bind(&raw_payload)
    .execute(&mut *tx)
    .await?;

    if grant_bonus_now {
        let bonus_note = if has_referrer {
            "Thưởng nạp đầu >= $1.00 nhân đôi ($10 Credit qua mã giới thiệu)"
        } else {
            "First deposit >= $1.00 promotional bonus"
        };
        sqlx::query(
            r#"
            INSERT INTO credit_transactions (
                user_id, tx_type, amount, balance_before, balance_after, note, metadata
            )
            VALUES ($1, 'FIRST_DEPOSIT_BONUS', $2, $3, $4, $5, $6)
            "#,
        )
        .bind(user_id)
        .bind(bonus_amount)
        .bind(after_deposit)
        .bind(final_balance)
        .bind(bonus_note)
        .bind(serde_json::json!({
            "trigger_deposit": credit_usd.to_string(),
            "referral_doubled_bonus": has_referrer
        }))
        .execute(&mut *tx)
        .await?;
    }

    sqlx::query(
        "INSERT INTO notifications (user_id, title, body) VALUES ($1, 'Nạp Credit thành công', $2)",
    )
    .bind(user_id)
    .bind(if grant_bonus_now {
        format!(
            "Đã cộng ${:.2} nạp và thưởng kích hoạt lần đầu ${:.2}. Tổng số dư: ${:.2}.",
            credit_usd, bonus_amount, final_balance
        )
    } else {
        format!(
            "Đã cộng ${:.2} vào Ví Credit. Số dư hiện tại: ${:.2}.",
            credit_usd, final_balance
        )
    })
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    info!(user_id = %user_id, credit_usd = %credit_usd, bonus = %bonus_amount, "deposit credited");
    Ok(())
}
