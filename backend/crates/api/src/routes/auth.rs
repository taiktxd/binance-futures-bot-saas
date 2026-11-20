use crate::auth_mw::{create_jwt, AuthUser};
use crate::state::{ApiError, ApiResult, AppState};
use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{extract::State, Json};
use common::{AppError, UserRecord};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Deserialize)]
pub struct RegisterRequest {
    pub email: String,
    pub password: String,
    pub telegram_chat_id: Option<String>,
    pub referral_code: Option<String>,
}

#[derive(Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Serialize)]
pub struct AuthResponse {
    pub token: String,
    pub user: UserRecord,
}

/// Registers a new account with $0.00 initial Credit to prevent spam accounts.
/// The $5.00 promotional credit is automatically granted upon first verified deposit >= $1.00.
pub async fn register(
    State(state): State<AppState>,
    Json(payload): Json<RegisterRequest>,
) -> ApiResult<Json<AuthResponse>> {
    let email = payload.email.trim().to_lowercase();
    if !email.contains('@') || payload.password.len() < 8 {
        return Err(ApiError(AppError::Validation(
            "valid email and password (min 8 chars) are required".to_string(),
        )));
    }

    let salt = SaltString::generate(&mut OsRng);
    let password_hash = Argon2::default()
        .hash_password(payload.password.as_bytes(), &salt)
        .map_err(|e| AppError::Internal(format!("password hashing failed: {e}")))?
        .to_string();

    let referrer_id: Option<Uuid> = if let Some(ref_code) = payload.referral_code.as_deref() {
        sqlx::query_scalar("SELECT id FROM users WHERE referral_code = $1")
            .bind(ref_code.trim().to_uppercase())
            .fetch_optional(&state.pool)
            .await?
    } else {
        None
    };

    let own_ref_code = format!(
        "EX-{}",
        Uuid::new_v4().simple().to_string()[..6].to_uppercase()
    );

    let user = sqlx::query_as::<_, UserRecord>(
        r#"
        INSERT INTO users (
            email, password_hash, telegram_chat_id,
            referral_code, referred_by_user_id, credit_balance, bonus_credit_granted
        )
        VALUES ($1, $2, $3, $4, $5, 0, FALSE)
        RETURNING *
        "#,
    )
    .bind(&email)
    .bind(&password_hash)
    .bind(payload.telegram_chat_id)
    .bind(&own_ref_code)
    .bind(referrer_id)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| {
        if e.to_string().contains("unique") || e.to_string().contains("duplicate") {
            AppError::Conflict("email is already registered".to_string())
        } else {
            AppError::Database(e)
        }
    })?;

    let _ = sqlx::query(
        r#"
        INSERT INTO notifications (user_id, title, body)
        VALUES ($1, 'Chào mừng đến với EXTREME', 'Nạp lần đầu tối thiểu $1.00 để kích hoạt khuyến mãi $5.00 Credit.')
        "#,
    )
    .bind(user.id)
    .execute(&state.pool)
    .await;

    let token = create_jwt(
        user.id,
        &user.email,
        user.role,
        &state.config.jwt_secret,
        state.config.jwt_expiration_hours,
    )?;

    Ok(Json(AuthResponse { token, user }))
}

pub async fn login(
    State(state): State<AppState>,
    Json(payload): Json<LoginRequest>,
) -> ApiResult<Json<AuthResponse>> {
    let email = payload.email.trim().to_lowercase();
    let user = sqlx::query_as::<_, UserRecord>("SELECT * FROM users WHERE email = $1")
        .bind(&email)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| AppError::Unauthorized("invalid email or password".to_string()))?;

    let parsed_hash = PasswordHash::new(&user.password_hash)
        .map_err(|_| AppError::Internal("corrupted password hash".to_string()))?;

    Argon2::default()
        .verify_password(payload.password.as_bytes(), &parsed_hash)
        .map_err(|_| AppError::Unauthorized("invalid email or password".to_string()))?;

    if !user.is_active {
        return Err(ApiError(AppError::Forbidden(
            "account is disabled".to_string(),
        )));
    }

    let token = create_jwt(
        user.id,
        &user.email,
        user.role,
        &state.config.jwt_secret,
        state.config.jwt_expiration_hours,
    )?;

    Ok(Json(AuthResponse { token, user }))
}

pub async fn me(State(state): State<AppState>, auth: AuthUser) -> ApiResult<Json<UserRecord>> {
    let user = sqlx::query_as::<_, UserRecord>("SELECT * FROM users WHERE id = $1")
        .bind(auth.user_id)
        .fetch_one(&state.pool)
        .await?;
    Ok(Json(user))
}
