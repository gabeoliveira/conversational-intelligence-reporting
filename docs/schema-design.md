# Schema Design Guide

## Consolidated vs. Separate Operators

### Recommended: Consolidated "conversation-intelligence" Operator

**Location:** `config/schemas/conversation-intelligence/v1.schema.json`

This single operator combines sentiment, intent, and summary analysis into one result, providing:

**Benefits:**
- ✅ **Lower Twilio costs** - One operator invocation vs. 3+ separate operators
- ✅ **Simpler processing** - Single webhook per conversation
- ✅ **Atomic results** - All analysis arrives together
- ✅ **Consistent versioning** - One version number for all features

**Structure:**
```json
{
  "summary": {
    "paragraph": "Customer called about billing issue...",
    "bullets": ["Point 1", "Point 2"],
    "action_items": [
      {
        "description": "Process refund",
        "assignee": "agent",
        "deadline": "2026-01-30T17:00:00Z",
        "status": "pending"
      }
    ],
    "topics_discussed": ["billing", "refund"],
    "outcome": "Issue resolved",
    "follow_up_required": false,
    "next_best_action": "Send confirmation email to customer"
  },
  "sentiment": {
    "overall": "positive",
    "score": 75,
    "confidence": 92,
    "key_phrases": ["thank you", "helpful"],
    "over_time": [...]
  },
  "classification": {
    "primary_intent": "problem",
    "primary_confidence": 95,
    "secondary_intents": [{...}],
    "intent_timeline": [...],
    "resolution_status": "resolved"
  },
  "quality": {
    "virtual_agent": {
      "resolved_questions": true,
      "avoided_hallucinations": true,
      "avoided_repetitions": true,
      "resolved_without_human": false,
      "maintained_consistency": true,
      "quality_score": 8.5
    },
    "human_agent": {
      "was_transferred": true,
      "resolved_questions": true,
      "was_cordial": true,
      "avoided_repetitions": true,
      "resolved_problem": true,
      "clear_closing": true,
      "quality_score": 9.2
    }
  }
}
```

**Note on Schema Validation:**
The JSON schema used for this operator (`config/schemas/conversation-intelligence/v1.schema.json`) is designed to be compatible with Twilio's JSON schema constraints. This means:
- Numeric ranges (e.g., 0-100 for scores, 0-10 for quality) are documented in descriptions, not enforced via `minimum`/`maximum`
- Date formats (ISO 8601) are documented in descriptions, not enforced via `format` keywords
- The LLM prompt must explicitly instruct proper ranges and formats since schema validation cannot enforce them

See the [JSON Schema Compatibility](#json-schema-compatibility) section below for details.

---

## AI Analytics Operator

**Location:** `config/schemas/poc-analytics/v2.schema.json` (v1 deprecated)

This operator analyzes AI virtual agent performance, conversation topics, handoff reasons, and inferred satisfaction. Designed for `GenerativeJSON` operator type.

**Fields:**
- `ai_retained` (boolean) — Whether the AI resolved without human transfer
- `topics` (array of objects) — Conversations can cover multiple topics. Each entry:
  - `primary_topic` (string, enum: 26 categories) — Main topic category
  - `subtopic` (string, enum: 273 deduped values) — Specific reason within the topic
  - `key_moment` (string) — Verbatim transcript sentence that triggered this classification
- `back_to_ivr` (boolean) — Customer returned to IVR
- `handoff_reason` (string, enum: `NONE`, `CUSTOMER_REQUEST`, `LACK_OF_COMPREHENSION`, `LACK_OF_KNOWLEDGE`) — Why a handoff occurred. Tracks AI acceptance, AI quality, and knowledge base quality respectively.
- `inferred_csat` (integer) — Inferred satisfaction 1-5
- `csat_reasoning` (string) — Explanation of why this CSAT score was inferred
- `errors` (boolean) — AI made mistakes (hallucinations, misconceptions)

**Aggregation:**
- Topics produce both `poc_topic_{primary}` (high-level pie chart) and `poc_subtopic_{primary_-_subtopic}` (detailed bar chart) metrics
- Handoff reasons produce `poc_handoff_{reason}` counters and `poc_handoff_{reason}_rate_percent` derived metrics (as % of all conversations)
- Multiple topics per conversation are each counted independently

**Metrics tracked:** See [bi-integration.md](./bi-integration.md#ai-analytics-metrics-from-analytics-operator) for the full catalog.

---

## Legacy: Separate Operators

**Note:** These schemas are maintained for backward compatibility but not recommended for new deployments.

### Individual Schemas

1. **`config/schemas/summary/v1.schema.json`**
   - Conversation summary and action items
   - Twilio operator: `conversation-summary`

2. **`config/schemas/sentiment/v1.schema.json`**
   - Sentiment analysis
   - Twilio operator: `sentiment-analysis`

3. **`config/schemas/intent/v1.schema.json`**
   - Intent detection
   - Twilio operator: `intent-detection`

**Trade-offs:**
- ✅ Individual versioning per feature
- ✅ Smaller schema files
- ❌ 3x Twilio operator costs
- ❌ 3 separate webhooks per conversation
- ❌ More complex processing pipeline

---

## Metrics Tracked

> **Heads-up — historical example.** The metric list below describes one possible operator schema (the legacy bundled `conversation-intelligence` operator). It is kept as a worked example, but **production tenants today emit metrics defined by [`config/operator-metrics.json`](../config/operator-metrics.json)** — see [README.md → Available Metrics](../README.md#get-metrics) and [`bi-integration.md` → Metrics Catalog](./bi-integration.md#metrics-catalog) for the live, config-driven naming rules. Names like `sentiment_avg` and `transfer_rate_percent` only appear if a tenant actually uses the `conversation-intelligence` schema and the operator emits those fields.

### For `conversation-intelligence` Operator

When this schema is in use, the system automatically tracks these metrics:

**Sentiment Metrics:**
- `sentiment_positive`, `sentiment_negative`, `sentiment_neutral` - Count per sentiment
- `sentiment_score_sum`, `sentiment_score_count` - For averaging (0-100 scale)
- `sentiment_avg` - Average sentiment score (computed, 0-100)

**Summary Metrics:**
- `summary_word_count_sum`, `summary_word_count_count` - Total and count
- `summary_avg_words` - Average summary length (computed)

**Classification Metrics:**
- `intent_scheduling`, `intent_cancellation`, `intent_problem`, `intent_other` - Count per intent type
- `resolution_resolved`, `resolution_unresolved`, `resolution_escalated`, `resolution_transferred` - Count per resolution status
- `intent_confidence_sum`, `intent_confidence_count` - For averaging (0-100 scale)
- `intent_avg_confidence` - Average intent confidence (computed, 0-100)

**Quality Metrics - Virtual Agent:**
- `virtual_agent_quality_sum`, `virtual_agent_quality_count` - For averaging
- `virtual_agent_quality_avg` - Average quality score (computed, 0-10 scale)
- `virtual_agent_resolved_questions` - Count of conversations where VA resolved questions
- `virtual_agent_avoided_hallucinations` - Count where VA avoided hallucinations
- `virtual_agent_avoided_repetitions` - Count where VA avoided repetitions
- `virtual_agent_resolved_without_human` - Count resolved without human transfer
- `virtual_agent_maintained_consistency` - Count where VA maintained consistency
- `virtual_agent_resolved_questions_percent` - Percentage (computed)
- `virtual_agent_resolved_without_human_percent` - Percentage (computed)
- `virtual_agent_avoided_hallucinations_percent` - Percentage (computed)
- `virtual_agent_avoided_repetitions_percent` - Percentage (computed)
- `virtual_agent_maintained_consistency_percent` - Percentage (computed)

**Quality Metrics - Human Agent:**
- `human_agent_transfers` - Total number of transfers to human agents
- `transfer_rate_percent` - Percentage of conversations transferred (computed)
- `human_agent_quality_sum`, `human_agent_quality_count` - For averaging
- `human_agent_quality_avg` - Average quality score (computed, 0-10 scale)
- `human_agent_resolved_questions` - Count where human resolved questions
- `human_agent_was_cordial` - Count where human was cordial
- `human_agent_avoided_repetitions` - Count where human avoided repetitions
- `human_agent_resolved_problem` - Count where human resolved the problem
- `human_agent_clear_closing` - Count where human provided clear closing
- `human_agent_resolved_questions_percent` - Percentage of transfers (computed)
- `human_agent_was_cordial_percent` - Percentage of transfers (computed)
- `human_agent_avoided_repetitions_percent` - Percentage of transfers (computed)
- `human_agent_resolved_problem_percent` - Percentage of transfers (computed)
- `human_agent_clear_closing_percent` - Percentage of transfers (computed)

**General Metrics:**
- `conversation_count` - Total conversations
- `operator_conversation-intelligence_count` - Operator execution count

### Adding Custom Metrics

Add an entry to `config/operator-metrics.json` for your operator. No TypeScript code needed:

```json
{
  "operatorName": "my-operator",
  "displayName": "My Operator",
  "metrics": [
    {
      "field": "follow_up_required",
      "type": "boolean",
      "metricPrefix": "followup",
      "displayName": "Follow-up Required"
    },
    {
      "field": "action_item_count",
      "type": "integer",
      "metricPrefix": "action_items",
      "displayName": "Action Items"
    }
  ]
}
```

The aggregation engine automatically:
- Tracks `followup_count` / `followup_total` and derives `followup_rate_percent`
- Tracks `action_items_sum` / `action_items_count` and derives `action_items_avg`
- Generates display names and makes `&metric=` filtering work

See [config-driven-metrics-plan.md](./config-driven-metrics-plan.md) for all primitive types and options.

---

## Twilio CI Operator Configuration

### JSON Schema Compatibility

**Important:** Twilio's Generative Custom Operators have specific JSON schema limitations:

**Not Supported:**
- `format` constraints (e.g., `"format": "date-time"`)
- `minimum`/`maximum` constraints on numbers
- `minLength`/`maxLength` on strings
- `pattern` on strings
- Selective `required` arrays within nested objects

**Automatic Overrides:**
- Twilio automatically sets `additionalProperties: false`
- Twilio automatically marks ALL fields as required

**Workaround:** Document expected formats and ranges in field descriptions instead of using validation keywords. For example:
- Instead of `"minimum": 0, "maximum": 100`, use description: `"Score from 0-100"`
- Instead of `"format": "date-time"`, use description: `"Timestamp in ISO 8601 format"`

See [Twilio's documentation](https://www.twilio.com/docs/conversational-intelligence/generative-custom-operators#json-output-format) for full details.

### Consolidated Operator Setup

When configuring your Twilio Conversational Intelligence operator:

1. **Operator Type:** JSON (Custom Generative - use `GenerativeJSON`)
2. **Operator Name:** `conversation-intelligence`
3. **Schema Version:** `1.0`
4. **Output Structure:** Must match the consolidated schema without unsupported constraints

**Example Twilio Operator Prompt:**

**CRITICAL:** Since Twilio cannot enforce numeric ranges or date formats in the schema, your prompt MUST explicitly specify all constraints:

```
Analyze this conversation and provide comprehensive intelligence. Follow these requirements exactly:

1. Summary:
   - paragraph: Concise paragraph summary (REQUIRED)
   - bullets: Array of key points as strings
   - action_items: Array of objects with:
     * description (REQUIRED)
     * assignee: "agent", "customer", or "system"
     * deadline: ISO 8601 timestamp (e.g., "2026-01-30T17:00:00Z")
     * status: "pending", "completed", or "cancelled"
   - topics_discussed: Array of strings
   - outcome: String describing resolution
   - follow_up_required: Boolean
   - next_best_action: Recommended next step

2. Sentiment Analysis of CUSTOMER:
   - overall: MUST be "positive", "neutral", or "negative" (REQUIRED)
   - score: MUST be a number between 0-100 where 0 is very negative and 100 is very positive (REQUIRED)
   - confidence: Number between 0-100 representing certainty
   - key_phrases: Array of strings that influenced analysis
   - over_time: Array with timestamp (ISO 8601), sentiment, score (0-100)

3. Classification:
   - primary_intent: MUST be "scheduling", "cancellation", "problem", or "other" (REQUIRED)
   - primary_confidence: Number between 0-100
   - secondary_intents: Array with intent (same options as primary) and confidence (0-100)
   - intent_timeline: Array with timestamp (ISO 8601), intent, trigger_phrase
   - resolution_status: "resolved", "unresolved", "escalated", or "transferred"

4. Quality Analysis:
   - virtual_agent (REQUIRED):
     * resolved_questions: Boolean
     * avoided_hallucinations: Boolean
     * avoided_repetitions: Boolean
     * resolved_without_human: Boolean
     * maintained_consistency: Boolean
     * quality_score: MUST be number between 0-10 (REQUIRED, 0 is worst, 10 is best, similar to CSAT)

   - human_agent (only if conversation was transferred):
     * was_transferred: Boolean
     * resolved_questions: Boolean
     * was_cordial: Boolean
     * avoided_repetitions: Boolean
     * resolved_problem: Boolean
     * clear_closing: Boolean
     * quality_score: Number between 0-10 (0 is worst, 10 is best)

Return the result as JSON following this structure:
{
  "summary": {
    "paragraph": "...",
    "bullets": [...],
    "action_items": [...],
    "topics_discussed": [...],
    "outcome": "...",
    "follow_up_required": true/false,
    "next_best_action": "..."
  },
  "sentiment": {
    "overall": "positive/neutral/negative",
    "score": 0-100,
    "confidence": 0-100,
    "key_phrases": [...],
    "over_time": [...]
  },
  "classification": {
    "primary_intent": "scheduling/cancellation/problem/other",
    "primary_confidence": 0-100,
    "secondary_intents": [...],
    "intent_timeline": [...],
    "resolution_status": "resolved/unresolved/escalated/transferred"
  },
  "quality": {
    "virtual_agent": {
      "resolved_questions": true/false,
      "avoided_hallucinations": true/false,
      "avoided_repetitions": true/false,
      "resolved_without_human": true/false,
      "maintained_consistency": true/false,
      "quality_score": 0-10
    },
    "human_agent": {
      "was_transferred": true/false,
      "resolved_questions": true/false,
      "was_cordial": true/false,
      "avoided_repetitions": true/false,
      "resolved_problem": true/false,
      "clear_closing": true/false,
      "quality_score": 0-10
    }
  }
}
```

---

## Migration from Separate to Consolidated

If you're currently using separate operators and want to migrate:

### Option 1: Clean Migration

1. Create new `conversation-intelligence` operator in Twilio
2. Update webhook configuration
3. Deploy CIRL with new schema
4. Archive old operators

### Option 2: Gradual Migration

1. Keep both old and new operators running
2. CIRL automatically handles both schema types
3. Compare results during transition period
4. Deprecate old operators once validated

**Backward Compatibility:**
The system continues to track metrics from separate operators (`sentiment`, `intent`, `summary`) if they're still in use, so you can run both approaches simultaneously.

---

## Best Practices

1. **Use Consolidated Schema for New Deployments**
   - Cost-effective
   - Simpler architecture
   - Easier to maintain

2. **Version Schema Carefully**
   - Use semantic versioning (v1, v2, etc.)
   - Document breaking changes
   - Support multiple versions during transitions

3. **Test Schema Changes**
   - Validate with sample payloads
   - Check metrics aggregation
   - Verify BI tool integration still works

4. **Monitor Operator Costs**
   - Track `operator_{name}_count` metrics
   - Calculate cost per conversation
   - Optimize operator selection based on ROI

---

## See Also

- [README.md](../README.md) - Main documentation
- [bi-integration.md](./bi-integration.md) - BI tool integration
- [config/schemas/](../config/schemas/) - All schemas
