const CATEGORY_ALIASES = {
  duplicate: "duplicate",
  missinginfo: "missing_information",
  missing_information: "missing_information",
  sensitivity: "security",
  security: "security",
  sentiment: "sentiment",
  backlog: "backlog_context",
  backlog_context: "backlog_context",
  health: "repository_health",
  repository_health: "repository_health",
};

const SCORE_THRESHOLD = 0.6;

function normalizeCategory(run) {
  const value = String(run.category || run.agentName || "").toLowerCase().replaceAll("-", "_");
  return CATEGORY_ALIASES[value] || value;
}

function outputOf(run) {
  return run.output && typeof run.output === "object" ? run.output : {};
}

function confidenceOf(run) {
  const output = outputOf(run);
  const value = output.confidence ?? output.duplicate_confidence ?? (output.danger_score !== undefined ? Number(output.danger_score) / 100 : run.confidence) ?? 0;
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function directDuplicate(run) {
  const output = outputOf(run);
  const action = String(run.suggestedAction || output.suggested_action || output.action || "").toLowerCase();
  const evidence = `${action} ${String(run.reasoning || "").toLowerCase()}`;
  return /\bduplicate\b/.test(evidence) && !/related/.test(evidence);
}

function backlogVerdict(run) {
  const output = outputOf(run);
  return String(output.verdict || output.action || run.suggestedAction || "").toLowerCase();
}

function healthInflection(run) {
  const output = outputOf(run);
  const text = `${JSON.stringify(output)} ${run.reasoning || ""}`.toLowerCase();
  return Boolean(output.inflection_point || output.inflectionPoint || output.is_inflection_point || /inflection[-\s]?point|change[-\s]?point|changepoint/.test(text)) && !/no\s+(clear\s+)?inflection|routine/.test(text);
}

function scoreRuns(agentRuns, hotspot = {}) {
  const threshold = Number(hotspot.threshold || SCORE_THRESHOLD);
  const breakdown = {};
  const triggeringCategories = [];
  let securityShortCircuit = false;
  let combinedScore = 0;
  let sentimentMultiplier = 1;
  const duplicateFailed = agentRuns.some((run) => normalizeCategory(run) === "duplicate" && run.status === "failed");

  for (const run of agentRuns) {
    const category = normalizeCategory(run);
    const confidence = confidenceOf(run);
    const output = outputOf(run);
    const breakdownEntry = { confidence, qualifies: false, signal: "none" };

    if (category === "security") {
      breakdownEntry.qualifies = confidence > 0.5;
      breakdownEntry.signal = output.is_security_sensitive === false ? "security result says no" : "confidence threshold";
      if (breakdownEntry.qualifies) securityShortCircuit = true;
    } else if (category === "duplicate") {
      breakdownEntry.qualifies = directDuplicate(run) && confidence >= 0.75;
      breakdownEntry.signal = directDuplicate(run) ? "direct duplicate" : "related or no duplicate action";
      if (breakdownEntry.qualifies) combinedScore += confidence;
    } else if (category === "missing_information") {
      breakdownEntry.signal = "never escalates alone";
    } else if (category === "sentiment") {
      const multiplier = Math.max(1, Math.min(2, Number(output.escalation_multiplier || output.escalationMultiplier || 1)));
      sentimentMultiplier = multiplier;
      breakdownEntry.multiplier = multiplier;
      breakdownEntry.signal = "multiplier only";
    } else if (category === "backlog_context") {
      breakdownEntry.qualifies = backlogVerdict(run) === "escalate";
      breakdownEntry.signal = backlogVerdict(run) || "no verdict";
      if (breakdownEntry.qualifies) combinedScore += confidence;
    } else if (category === "repository_health") {
      breakdownEntry.qualifies = healthInflection(run);
      breakdownEntry.signal = breakdownEntry.qualifies ? "inflection point" : "routine or no inflection";
      if (breakdownEntry.qualifies) combinedScore += confidence;
    }

    breakdown[category] = breakdownEntry;
    if (breakdownEntry.qualifies) triggeringCategories.push(category);
  }

  const aggregateConfidence = Math.max(0, Math.min(1, combinedScore * sentimentMultiplier));
  if (securityShortCircuit) triggeringCategories.unshift("security");
  const urgencyReasons = [];
  let urgency = Math.round(aggregateConfidence * 60);
  if (securityShortCircuit) { urgency += 35; urgencyReasons.push("security sensitivity"); }
  if (hotspot.isDuplicateHotspot) { urgency += 20; urgencyReasons.push(`${hotspot.duplicateHotspotCount} open duplicate issues`); }
  if (sentimentMultiplier > 1) { urgency += Math.round((sentimentMultiplier - 1) * 20); urgencyReasons.push("contention or sentiment signal"); }
  if (duplicateFailed) { urgency += 25; urgencyReasons.push("duplicate detection failed"); }
  urgency = Math.max(0, Math.min(100, urgency));
  return {
    needsAttention: securityShortCircuit || aggregateConfidence >= threshold || hotspot.isDuplicateHotspot || duplicateFailed,
    triggeringCategories: [...new Set(triggeringCategories)],
    aggregateConfidence,
    perCategoryBreakdown: breakdown,
    urgency,
    isDuplicateHotspot: Boolean(hotspot.isDuplicateHotspot),
    duplicateHotspotCount: hotspot.duplicateHotspotCount || 0,
    urgencyReasons,
    threshold,
  };
}

module.exports = { CATEGORY_ALIASES, SCORE_THRESHOLD, normalizeCategory, scoreRuns };
