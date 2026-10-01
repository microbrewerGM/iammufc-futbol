# P17 low-cost intent-model evaluation

Status: Gemma 4 bounded dev canary prepared; no model is approved for ordinary traffic.

The natural-language layer may propose a `QueryIntent`. It never decides
rights or feasibility, executes SQL, or selects data. The existing deterministic
input gate, catalog lookup, proposal validator, and rules fallback remain the
product boundary.

## Frozen evaluation

`tests/vectors/p17-intent-evaluation-v2.json` contains 48 labelled EN/ES
questions (24 development, 24 held out) and a separate 12-case model-output
safety matrix. The held-out labels are frozen before candidate prompting.
Every candidate must run three independent samples per question.

`tests/support/p17-evaluator.ts` accepts sanitized trial facts and emits only
aggregate results. It deliberately cannot retain questions or provider output.
It fails closed unless all of these are true:

- at least 40 question cases and 20 held-out question cases are present;
- held-out exact outcome agreement is at least 95%;
- no unsupported outcome is accepted;
- provider-failure fallback has separate evidence;
- the predeclared cost gate is met.

Candidate accuracy and complete-system accuracy must be reported separately;
a correct rules fallback does not make an incorrect model response correct.
The report must also include per-field and per-category accuracy, latency,
availability, measured cost, and within-case stability.

The tests in this change validate the frozen labels, deterministic baseline,
model-output validator, and scoring arithmetic. They are not a live candidate
run and do not satisfy the release gate by themselves.

## Provider decision, 2026-10-01

Cloudflare Workers AI is the first candidate because the Worker already has an
AI binding, no new browser or repository credential is needed, and the current
free allocation is 10,000 neurons per day. Usage above that allocation requires
Workers Paid and is currently $0.011 per 1,000 neurons. The first bounded canary
is `@cf/zai-org/glm-4.7-flash`; `@cf/google/gemma-4-26b-a4b-it` is the second
candidate. Both remain behind the existing validator and rules fallback.

Cost gate: a candidate evaluation must fit inside the 10,000-neuron daily free
allocation and therefore incur $0 direct marginal cost. Record measured neuron
usage and the paid-plan equivalent. Exceeding the free allocation is a failed
gate, not authorization to enable paid inference.

OpenRouter Free remains useful for development analysis, but is not the website
runtime default. Its current free plan advertises 50 requests per day and lacks
the budgets and data-policy routing controls listed for paid plans, which is too
variable and too operationally weak for the product request path.

Jev remains deferred. A typed Choice decision can be appropriate for a measured,
closed-set classification seam, but the current routing and refusal decisions
already have deterministic rules. No TypeSafe dependency is justified until
the corpus identifies a specific ambiguity where calibrated probability
improves the code-owned workflow.

Current sources:

- [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Workers AI free-plan model availability](https://developers.cloudflare.com/changelog/post/2026-07-28-models-require-workers-paid/)
- [Workers AI function calling](https://developers.cloudflare.com/workers-ai/features/function-calling/)
- [OpenRouter pricing](https://openrouter.ai/pricing)
- [TypeSafe documentation index](https://docs.typesafe.ai/llms.txt)

## GLM 4.7 Flash canary result

The service-scoped canary stopped at `en_supported`, trial 1, on 2026-10-01.
That is a failed candidate under the frozen gate, so the 48-question evaluation
did not run and the temporary activation route and workflow input were removed.
`AI_PROPOSALS_ENABLED` remains unset and every ordinary dev request remains
rules-only. The current response normalizer and complete deterministic-intent
equality check stay in place as hardening for any future candidate.

## Gemma 4 bounded canary declaration

The second candidate is pinned to `@cf/google/gemma-4-26b-a4b-it`. Its request
uses `max_completion_tokens: 200`, `temperature: 0`, and
`chat_template_kwargs: { enable_thinking: false }`. The response is accepted
only through the existing strict output decoder, schema validator, catalog
boundary, and complete canonical equality check against the rule result.

The temporary `gemma4-v1` marker activates inference only for the already
verified allowlisted Access service identity. Human sessions, missing or stale
markers, and ordinary service requests remain rules-only. The manually invoked
dev workflow always completes the baseline Access smoke before attempting the
six-case, three-trial canary. The canary stops at the first failure, emits only
aggregate pass/latency facts or finite case/trial/failure identifiers, and makes
at most 18 inference calls. Runtime provider responses and request bodies are
not emitted or persisted; the fixed evaluation prompts remain source-controlled.

At current published rates, Gemma 4 costs $0.10 per million input tokens and
$0.30 per million output tokens. This bounded run must stay within the Workers
AI free daily allocation; paid inference is not authorized. Whether the canary
passes or fails, the marker route and workflow input are removed immediately
after the run. A pass would still require aggregate usage metering and the
frozen held-out evaluation before ordinary inference could be considered.
