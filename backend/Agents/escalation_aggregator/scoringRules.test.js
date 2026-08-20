const assert = require("node:assert/strict");
const { scoreRuns } = require("./scoringRules");

function run(category, values = {}) {
  return {
    category,
    agentName: category,
    confidence: values.confidence ?? 0,
    reasoning: values.reasoning || "",
    suggestedAction: values.suggestedAction || "",
    output: values.output || {},
  };
}

function six(overrides = {}) {
  return [
    run("duplicate", overrides.duplicate),
    run("missingInfo", overrides.missingInfo),
    run("sensitivity", overrides.sensitivity),
    run("sentiment", overrides.sentiment),
    run("backlog", overrides.backlog),
    run("health", overrides.health),
  ];
}

const noSignal = scoreRuns(six());
assert.equal(noSignal.needsAttention, false);

const security = scoreRuns(six({ sensitivity: { confidence: 0.51 } }));
assert.equal(security.needsAttention, true);
assert.deepEqual(security.triggeringCategories, ["security"]);

const relatedDuplicate = scoreRuns(six({ duplicate: { confidence: 0.99, suggestedAction: "keep related" } }));
assert.equal(relatedDuplicate.needsAttention, false);

const directDuplicate = scoreRuns(six({ duplicate: { confidence: 0.75, suggestedAction: "close as duplicate" } }));
assert.equal(directDuplicate.needsAttention, true);
assert.ok(directDuplicate.triggeringCategories.includes("duplicate"));

const missingOnly = scoreRuns(six({ missingInfo: { confidence: 1, suggestedAction: "request details" } }));
assert.equal(missingOnly.needsAttention, false);

const sentimentBoost = scoreRuns(six({
  sentiment: { output: { escalation_multiplier: 2 } },
  backlog: { confidence: 0.31, output: { verdict: "escalate" } },
},));
assert.equal(sentimentBoost.needsAttention, true);

const nudgeBacklog = scoreRuns(six({ backlog: { confidence: 1, output: { verdict: "nudge" } } }));
assert.equal(nudgeBacklog.needsAttention, false);

const routineHealth = scoreRuns(six({ health: { confidence: 1, output: { response_time: 99 }, reasoning: "routine metric values" } }));
assert.equal(routineHealth.needsAttention, false);

console.log("scoringRules tests passed");
