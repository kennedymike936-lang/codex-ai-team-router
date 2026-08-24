export const VALIDATION_PROFILES = ["auto", "fast", "standard", "full"];

const FULL_RISK_WORDS = /\b(?:auth(?:entication|orization)?|security|secret|credential|permission|payment|billing|database migration|schema migration|destructive|delete|drop|production|deploy(?:ment)?|release|dependency|lockfile|encryption)\b|认证|鉴权|安全|密钥|凭据|权限|支付|计费|数据库迁移|结构迁移|破坏性|删除|生产|部署|发布|依赖|锁文件|加密/i;
const DEPENDENCY_FILES = /(?:^|\/)(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements\.txt|pyproject\.toml|poetry\.lock|Pipfile|Cargo\.toml|Cargo\.lock)$/i;

function normalizePaths(values = []) {
  if (!Array.isArray(values)) return [];
  return values.map((value) => String(value || "").trim().replace(/\\/g, "/")).filter(Boolean);
}

export function selectValidationProfile({ requested = "auto", mode = "implement", task = "", allowedPaths = [] } = {}) {
  const normalizedRequested = VALIDATION_PROFILES.includes(String(requested).toLowerCase())
    ? String(requested).toLowerCase()
    : "auto";

  if (normalizedRequested !== "auto") {
    return { requested: normalizedRequested, effective: normalizedRequested, reason: "explicit" };
  }
  if (mode !== "implement") {
    return { requested: "auto", effective: "fast", reason: "read_only" };
  }
  if (normalizePaths(allowedPaths).some((path) => DEPENDENCY_FILES.test(path))) {
    return { requested: "auto", effective: "full", reason: "dependency_scope" };
  }
  if (FULL_RISK_WORDS.test(String(task || ""))) {
    return { requested: "auto", effective: "full", reason: "high_risk_intent" };
  }
  return { requested: "auto", effective: "standard", reason: "ordinary_implementation" };
}

export function shouldRunValidationGate(profile, explicitRunGate) {
  if (explicitRunGate === false) return false;
  return profile?.effective !== "fast";
}

