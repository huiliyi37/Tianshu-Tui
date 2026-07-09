//! 桌面端在线激活 — 本地验签 + 设备指纹 + 离线宽限。
//!
//! 真校验全在 Rust(编译进机器码,前端 patch 绕不过)。网络调用放前端
//! (JS fetch 打授权服务器),前端把服务器签发的 token 交给 `store_license`
//! 做 Ed25519 验签后落盘。gate 在 `lib.rs` 的 sidecar spawn 前:未激活不拉起
//! agent runtime。
//!
//! Token 契约(与 `license-server/src/token.ts` 一致):
//!   token = base64url(JSON(payload)) + "." + base64url(ed25519_sig)
//! 签名对象是**第一段 base64url 字符串的 ASCII 字节**(不是原始 JSON)。

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};

/// 产品标识 — 三处必须一致:授权服务器 `PRODUCT` / token payload / 此处。
const PRODUCT: &str = "tianshu-desktop";

/// 离线宽限期(天):最近一次成功联网校验后,即便 token 过期 / 服务器不可达,
/// 仍允许本地运行这么久,避免服务器故障锁死付费用户。
const OFFLINE_GRACE_DAYS: i64 = 10;

/// 授权服务器签发公钥(raw 32 字节,标准 base64)。
///
/// ⚠️ 部署前必须替换为 `license-server` 的 `npm run genkeys` 输出的 PUBLIC KEY。
/// 占位值(全零)不会匹配任何真实签名 → 所有 token 验签失败 → fail-closed 锁死,
/// 这是有意的:没有真实密钥 + 真实服务器,加固版就不该跑起来。开发期用
/// `RIVET_ACTIVATION_DEV_BYPASS=1`(仅 debug 构建生效)绕过。
const PUBLIC_KEY_B64: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseStatus {
    pub activated: bool,
    pub tier: Option<String>,
    /// token 过期时间(unix ms)。
    pub token_exp: Option<i64>,
    /// 许可有效期终点(unix ms);None = 永久。
    pub license_expires: Option<i64>,
    /// 是否处于离线宽限期(token 已过期但最近校验过)。
    pub grace: bool,
    /// 宽限期截止(unix ms),仅 grace=true 时有意义。
    pub grace_until: Option<i64>,
    /// 未激活原因 / 状态标签(activated=true 时为 "ok" 或 "grace")。
    pub reason: String,
    /// 本机设备指纹。
    pub device_id: String,
}

impl LicenseStatus {
    fn locked(device_id: String, reason: &str) -> Self {
        LicenseStatus {
            activated: false,
            tier: None,
            token_exp: None,
            license_expires: None,
            grace: false,
            grace_until: None,
            reason: reason.to_string(),
            device_id,
        }
    }
}

#[derive(Debug, Deserialize)]
struct TokenPayload {
    product: String,
    #[serde(rename = "deviceId")]
    device_id: String,
    #[serde(default)]
    tier: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    iat: i64,
    exp: i64,
    #[serde(default)]
    lic: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize)]
struct StoredLicense {
    token: String,
    #[serde(rename = "lastVerifiedAt")]
    last_verified_at: i64,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn license_path(rivet_home: &Path) -> PathBuf {
    rivet_home.join("license.json")
}

fn device_id_path(rivet_home: &Path) -> PathBuf {
    rivet_home.join(".device-id")
}

/// 稳定设备指纹:优先硬件机器 ID(machine-uid),失败降级到持久化随机 ID。
/// 输出经过清洗以匹配服务器的 device-id 正则 `[A-Za-z0-9._:-]{8,128}`。
pub fn device_id(rivet_home: &Path) -> String {
    if let Ok(uid) = machine_uid::get() {
        let sane = sanitize_device_id(&uid);
        if sane.len() >= 8 {
            return sane;
        }
    }
    // 降级:持久化一个随机 ID(首次生成,之后复用)。
    let path = device_id_path(rivet_home);
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let s = sanitize_device_id(existing.trim());
        if s.len() >= 8 {
            return s;
        }
    }
    let generated = generate_random_id();
    let _ = std::fs::create_dir_all(rivet_home);
    let _ = std::fs::write(&path, &generated);
    generated
}

fn sanitize_device_id(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
        .take(128)
        .collect();
    cleaned
}

fn generate_random_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    let hex: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();
    format!("dev-{}", hex)
}

fn verifying_key() -> Option<VerifyingKey> {
    let raw = STANDARD.decode(PUBLIC_KEY_B64).ok()?;
    let arr: [u8; 32] = raw.try_into().ok()?;
    VerifyingKey::from_bytes(&arr).ok()
}

/// 本地验签 + 解析 payload。不做过期/设备匹配判断(交给调用方)。
fn verify_and_decode(token: &str) -> Result<TokenPayload, String> {
    let key = verifying_key().ok_or("bad_public_key")?;
    verify_and_decode_with_key(token, &key)
}

/// 验签核心(密钥可注入)。生产路径用编译进机器码的 `verifying_key()`;
/// 测试用注入密钥,以验证与授权服务器 `token.ts` 的跨语言签名契约。
fn verify_and_decode_with_key(token: &str, key: &VerifyingKey) -> Result<TokenPayload, String> {
    let dot = token.find('.').ok_or("malformed_token")?;
    let (payload_b64, sig_seg) = token.split_at(dot);
    let sig_b64 = &sig_seg[1..];

    let sig_bytes = URL_SAFE_NO_PAD
        .decode(sig_b64)
        .map_err(|_| "bad_signature_b64")?;
    let sig_arr: [u8; 64] = sig_bytes.try_into().map_err(|_| "bad_signature_len")?;
    let sig = Signature::from_bytes(&sig_arr);
    key.verify(payload_b64.as_bytes(), &sig)
        .map_err(|_| "signature_invalid")?;

    let payload_json = URL_SAFE_NO_PAD
        .decode(payload_b64)
        .map_err(|_| "bad_payload_b64")?;
    let payload: TokenPayload =
        serde_json::from_slice(&payload_json).map_err(|_| "bad_payload_json")?;
    Ok(payload)
}

/// 读取本地 license 状态:验签 + 过期 + 设备匹配 + 离线宽限。
pub fn read_status(rivet_home: &Path) -> LicenseStatus {
    let dev = device_id(rivet_home);
    let raw = match std::fs::read_to_string(license_path(rivet_home)) {
        Ok(s) => s,
        Err(_) => return LicenseStatus::locked(dev, "not_activated"),
    };
    let stored: StoredLicense = match serde_json::from_str(&raw) {
        Ok(s) => s,
        Err(_) => return LicenseStatus::locked(dev, "corrupt_license"),
    };
    evaluate(&stored, &dev)
}

fn evaluate(stored: &StoredLicense, dev: &str) -> LicenseStatus {
    let payload = match verify_and_decode(&stored.token) {
        Ok(p) => p,
        Err(reason) => return LicenseStatus::locked(dev.to_string(), &reason),
    };
    evaluate_decoded(&payload, stored.last_verified_at, dev, now_ms())
}

/// 过期 / 设备匹配 / 离线宽限的纯业务逻辑(`now` 注入以便确定性测试)。
fn evaluate_decoded(
    payload: &TokenPayload,
    last_verified_at: i64,
    dev: &str,
    now: i64,
) -> LicenseStatus {
    if payload.product != PRODUCT {
        return LicenseStatus::locked(dev.to_string(), "product_mismatch");
    }
    if payload.device_id != dev {
        return LicenseStatus::locked(dev.to_string(), "device_mismatch");
    }
    // 许可硬过期:即便在宽限期内也不放行。
    if let Some(lic) = payload.lic {
        if now > lic {
            return LicenseStatus::locked(dev.to_string(), "license_expired");
        }
    }
    let grace_until = last_verified_at + OFFLINE_GRACE_DAYS * 86_400_000;
    if now <= payload.exp {
        LicenseStatus {
            activated: true,
            tier: payload.tier.clone(),
            token_exp: Some(payload.exp),
            license_expires: payload.lic,
            grace: false,
            grace_until: None,
            reason: "ok".to_string(),
            device_id: dev.to_string(),
        }
    } else if now <= grace_until {
        // token 过期但最近成功校验过 → 离线宽限放行。
        LicenseStatus {
            activated: true,
            tier: payload.tier.clone(),
            token_exp: Some(payload.exp),
            license_expires: payload.lic,
            grace: true,
            grace_until: Some(grace_until),
            reason: "grace".to_string(),
            device_id: dev.to_string(),
        }
    } else {
        LicenseStatus::locked(dev.to_string(), "token_expired")
    }
}

/// 验签服务器签发的 token,通过则落盘并刷新 last_verified_at。
/// 前端在 /activate 或 /verify 心跳成功后调用。
pub fn store_license(rivet_home: &Path, token: &str) -> Result<LicenseStatus, String> {
    let dev = device_id(rivet_home);
    let payload = verify_and_decode(token)?;
    if payload.product != PRODUCT {
        return Err("product_mismatch".to_string());
    }
    if payload.device_id != dev {
        return Err("device_mismatch".to_string());
    }
    let stored = StoredLicense {
        token: token.to_string(),
        last_verified_at: now_ms(),
    };
    let json = serde_json::to_string(&stored).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(rivet_home).map_err(|e| e.to_string())?;
    std::fs::write(license_path(rivet_home), json).map_err(|e| e.to_string())?;
    Ok(evaluate(&stored, &dev))
}

/// 读取当前落盘的 token(供前端 /verify 心跳携带)。token 是设备绑定的,
/// 暴露给前端价值极低(拷到他机验签 device_mismatch)。
pub fn current_token(rivet_home: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(license_path(rivet_home)).ok()?;
    let stored: StoredLicense = serde_json::from_str(&raw).ok()?;
    Some(stored.token)
}

/// 移除本地 license(退激活)。gate 在下次启动 / 心跳时生效。
pub fn clear_license(rivet_home: &Path) -> Result<(), String> {
    let path = license_path(rivet_home);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// gate 便捷判断:是否允许拉起 agent runtime。
pub fn is_activated(rivet_home: &Path) -> bool {
    // 仅 debug 构建honor 开发绕过环境变量;release(tauri:build)构建永不生效。
    #[cfg(debug_assertions)]
    if std::env::var("RIVET_ACTIVATION_DEV_BYPASS").is_ok() {
        return true;
    }
    read_status(rivet_home).activated
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn test_keypair() -> (SigningKey, VerifyingKey) {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let vk = sk.verifying_key();
        (sk, vk)
    }

    /// 按 `token.ts` 契约签发:签名对象是 base64url(JSON(payload)) 的 ASCII 字节。
    fn sign_token(sk: &SigningKey, payload_json: &str) -> String {
        let payload_b64 = URL_SAFE_NO_PAD.encode(payload_json.as_bytes());
        let sig = sk.sign(payload_b64.as_bytes());
        let sig_b64 = URL_SAFE_NO_PAD.encode(sig.to_bytes());
        format!("{payload_b64}.{sig_b64}")
    }

    fn payload(dev: &str, exp: i64, lic: Option<i64>) -> TokenPayload {
        TokenPayload {
            product: PRODUCT.to_string(),
            device_id: dev.to_string(),
            tier: Some("pro".to_string()),
            iat: 0,
            exp,
            lic,
        }
    }

    #[test]
    fn verify_accepts_contract_conformant_token() {
        let (sk, vk) = test_keypair();
        let json = r#"{"product":"tianshu-desktop","deviceId":"dev-abc123def456","tier":"pro","iat":1000,"exp":9999999999999}"#;
        let token = sign_token(&sk, json);
        let payload = verify_and_decode_with_key(&token, &vk).expect("should verify");
        assert_eq!(payload.product, PRODUCT);
        assert_eq!(payload.device_id, "dev-abc123def456");
        assert_eq!(payload.tier.as_deref(), Some("pro"));
        assert_eq!(payload.exp, 9999999999999);
    }

    #[test]
    fn verify_rejects_tampered_signature() {
        let (sk, vk) = test_keypair();
        let json = r#"{"product":"tianshu-desktop","deviceId":"dev-abc123def456","iat":1,"exp":2}"#;
        let mut token = sign_token(&sk, json);
        token.pop();
        token.push(if token.ends_with('A') { 'B' } else { 'A' });
        assert!(verify_and_decode_with_key(&token, &vk).is_err());
    }

    #[test]
    fn verify_rejects_wrong_key() {
        let (sk, _) = test_keypair();
        let other = SigningKey::from_bytes(&[9u8; 32]).verifying_key();
        let json = r#"{"product":"tianshu-desktop","deviceId":"dev-abc123def456","iat":1,"exp":9999999999999}"#;
        let token = sign_token(&sk, json);
        assert!(verify_and_decode_with_key(&token, &other).is_err());
    }

    #[test]
    fn evaluate_active_when_token_fresh() {
        let s = evaluate_decoded(&payload("dev-1", 1_000, None), 0, "dev-1", 500);
        assert!(s.activated);
        assert_eq!(s.reason, "ok");
        assert!(!s.grace);
    }

    #[test]
    fn evaluate_grace_when_expired_but_recently_verified() {
        let s = evaluate_decoded(&payload("dev-1", 500, None), 1_000, "dev-1", 1_000);
        assert!(s.activated);
        assert!(s.grace);
        assert_eq!(s.reason, "grace");
    }

    #[test]
    fn evaluate_locked_beyond_grace() {
        let grace_ms = OFFLINE_GRACE_DAYS * 86_400_000;
        let s = evaluate_decoded(&payload("dev-1", 500, None), 0, "dev-1", grace_ms + 1);
        assert!(!s.activated);
        assert_eq!(s.reason, "token_expired");
    }

    #[test]
    fn evaluate_locked_on_device_mismatch() {
        let s = evaluate_decoded(&payload("dev-OTHER", 9_999, None), 0, "dev-1", 1);
        assert!(!s.activated);
        assert_eq!(s.reason, "device_mismatch");
    }

    #[test]
    fn evaluate_locked_on_hard_license_expiry() {
        let s = evaluate_decoded(&payload("dev-1", 9_999_999, Some(1_000)), 9_999_999, "dev-1", 2_000);
        assert!(!s.activated);
        assert_eq!(s.reason, "license_expired");
    }

    /// 跨语言互操作:提供 Node(`token.ts` / Web Crypto)签发的真 token 与公钥时,
    /// 证明 crypto.subtle Ed25519 与 ed25519-dalek 完全互认。无密钥时自动跳过。
    #[test]
    fn verify_accepts_node_signed_token_when_provided() {
        let (token, pubkey_b64) = match (
            std::env::var("RIVET_TEST_NODE_TOKEN"),
            std::env::var("RIVET_TEST_NODE_PUBKEY_B64"),
        ) {
            (Ok(t), Ok(k)) => (t, k),
            _ => return,
        };
        let raw = STANDARD.decode(pubkey_b64.trim()).expect("pubkey b64");
        let arr: [u8; 32] = raw.try_into().expect("32-byte key");
        let vk = VerifyingKey::from_bytes(&arr).expect("valid key");
        let payload = verify_and_decode_with_key(&token, &vk)
            .expect("Node-signed token must verify in Rust");
        assert_eq!(payload.product, PRODUCT);
        eprintln!(
            "[interop] Node-signed token verified in Rust: device={} exp={}",
            payload.device_id, payload.exp
        );
    }
}
