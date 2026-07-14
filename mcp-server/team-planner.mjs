const LIVE_RESEARCH_WORDS = /\b(latest|current|today|recent|news|price|pricing|version|release|announcement|official docs?|web search|x\.com|twitter|social sentiment)\b|最新|当前|今天|近期|新闻|价格|版本|发布|公告|官方文档|联网搜索|实时|推特|舆情/i;
const ARCHITECTURE_WORDS = /\b(architecture|architect|migration|migrate|cross[- ]module|multi[- ]module|distributed|platform|framework|redesign|rewrite)\b|架构|迁移|跨模块|多模块|分布式|平台|框架|重写|重新设计/i;
const END_TO_END_WORDS = /\b(end[- ]to[- ]end|full[- ]stack|entire (app|project|system)|from scratch|production[- ]ready|complete (app|project|system))\b|端到端|全栈|整个项目|完整项目|从零开始|生产可用/i;
const RISK_WORDS = /\b(security|auth|payment|billing|database|data migration|concurrency|performance|privacy|deployment|infrastructure)\b|安全|认证|支付|计费|数据库|数据迁移|并发|性能|隐私|部署|基础设施/i;
const INTERACTIVE_APP_WORDS = /\b(game|canvas|webgl|three\.js|raycast(?:ing)?|first[- ]person|fps|simulation|interactive app)\b|游戏|画布|射线投射|第一人称|模拟器|交互应用/i;
const INTERACTIVE_FEATURE_WORDS = [
  /\b(animation|render loop|real[- ]time)\b|动画|渲染循环|实时渲染/i,
  /\b(pointer lock|keyboard|mouse|touch|controller|input)\b|指针锁定|键盘|鼠标|触控|手柄|输入控制/i,
  /\b(collision|physics|movement)\b|碰撞|物理|移动系统/i,
  /\b(enem(?:y|ies)|wave|combat|ai behavior)\b|敌人|波次|战斗|行为逻辑/i,
  /\b(hud|minimap|score|health|ammo|reload|pickup)\b|抬头显示|小地图|得分|生命|弹药|换弹|补给/i,
  /\b(audio|particle|effect|win|game over|state machine)\b|音效|粒子|特效|胜利|失败|状态机/i,
];
const DISCIPLINE_WORDS = [
  /\b(frontend|ui|css|react|vue)\b|前端|界面/i,
  /\b(backend|server|api|service)\b|后端|服务端|接口/i,
  /\b(database|sql|schema|storage)\b|数据库|存储/i,
  /\b(test|testing|typecheck|lint|quality)\b|测试|类型检查|代码质量/i,
  /\b(deploy|deployment|docker|ci|cd|cloud)\b|部署|容器|流水线|云服务/i,
  /\b(docs?|readme|documentation)\b|文档|说明/i,
];

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function listItemCount(text) {
  return String(text)
    .split(/\r?\n/)
    .filter((line) => /^\s*(?:[-*]|\d+[.)]|[一二三四五六七八九十]+[、.])\s*/.test(line))
    .length;
}

export function analyzeTaskComplexity({ task = "", context = "", allowedPaths = [] } = {}) {
  const text = `${task}\n${context}`.trim();
  let score = 0;
  const reasons = [];

  if (text.length >= 600) {
    score += 2;
    reasons.push("long specification");
  } else if (text.length >= 220) {
    score += 1;
    reasons.push("multi-part specification");
  }

  const items = listItemCount(text);
  if (items >= 6) {
    score += 2;
    reasons.push("many acceptance items");
  } else if (items >= 3) {
    score += 1;
    reasons.push("several acceptance items");
  }

  if (ARCHITECTURE_WORDS.test(text)) {
    score += 2;
    reasons.push("architecture or migration scope");
  }
  const hasEndToEndScope = END_TO_END_WORDS.test(text);
  if (hasEndToEndScope) {
    score += 2;
    reasons.push("end-to-end delivery");
  }
  if (RISK_WORDS.test(text)) {
    score += 1;
    reasons.push("higher-risk subsystem");
  }

  const isInteractiveApp = INTERACTIVE_APP_WORDS.test(text);
  if (isInteractiveApp) {
    score += 1;
    reasons.push("interactive application");
    const interactiveFeatures = INTERACTIVE_FEATURE_WORDS.filter((pattern) => pattern.test(text)).length;
    if (interactiveFeatures >= 3) {
      score += 2;
      reasons.push("several interactive systems");
    } else if (interactiveFeatures >= 2) {
      score += 1;
      reasons.push("multiple interactive systems");
    }
  }

  const disciplines = DISCIPLINE_WORDS.filter((pattern) => pattern.test(text)).length;
  if (disciplines >= 4) {
    score += 2;
    reasons.push("four or more engineering disciplines");
  } else if (disciplines >= 2) {
    score += 1;
    reasons.push("multiple engineering disciplines");
  }
  if (hasEndToEndScope && disciplines >= 3) {
    score += 2;
    reasons.push("end-to-end multi-discipline delivery");
  }

  const pathCount = Array.isArray(allowedPaths) ? allowedPaths.length : 0;
  if (pathCount >= 5) {
    score += 2;
    reasons.push("broad file scope");
  } else if (pathCount >= 2) {
    score += 1;
    reasons.push("multiple file scopes");
  }

  const level = score >= 6 ? "complex" : score >= 3 ? "medium" : "small";
  return {
    level,
    score,
    reasons,
    needs_live_research: LIVE_RESEARCH_WORDS.test(text),
  };
}

export function planTaskTeam({ task = "", context = "", allowedPaths = [], maxAssistants = 3 } = {}) {
  const complexity = analyzeTaskComplexity({ task, context, allowedPaths });
  const cap = clampInteger(maxAssistants, 3, 1, 3);
  const codingAssistants = Math.min(cap, complexity.level === "small" ? 1 : 2);
  const useGrok = complexity.needs_live_research && complexity.level === "complex" && cap >= 3;
  return {
    complexity,
    max_assistants: cap,
    coding_assistants: codingAssistants,
    use_planner: codingAssistants >= 2,
    use_grok: useGrok,
    assistant_count: codingAssistants + (useGrok ? 1 : 0),
  };
}
