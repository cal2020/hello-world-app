import { CASES } from './cases.js'
import { esc } from './html.js'

export function renderPlan() {
  const mix = [
    ['Clear matches', 10, 'Same fault, same behavior, current revision'],
    ['Paraphrases', 10, 'Different vocabulary for the same fault and response'],
    ['Ambiguous evidence', 8, 'Related fault or partial coverage; the expected answer is “ambiguous”'],
    ['Contradictions', 8, 'Evidence shows the requirement is not met, including “PASS” with a failing number'],
    ['Changed revisions', 8, 'Evidence tied to an earlier requirement or evidence revision'],
    ['Distractors and embedded instructions', 6, 'Long irrelevant context, or text addressed to automated reviewers'],
  ]
  const metrics = [
    ['Median review time', 'Seconds from opening a candidate to recording a decision, per arm'],
    ['Incorrect accepted links', 'Accepted “verifies” links that the held-out label says are wrong. This is the guardrail metric.'],
    ['Abstentions', 'Share of cases answered “ambiguous” or “insufficient evidence”, and whether those abstentions were warranted'],
    ['Latency', 'p50 and p95 per judgment, measured in the target environment'],
    ['Total cost', 'Model calls plus integration and operating effort, not only price per call'],
  ]
  return `
  <div class="prose">
    <p class="status-banner"><span class="pill pill-warn">Not run</span> This is a proposed experiment. No prototype evaluation has been run, and none of its results exist yet.</p>

    <h2>Question</h2>
    <p>Where engineers still interpret meaning to link requirements to test evidence, does a bounded semantic judgment cut total review effort without letting more wrong links through? Answering that starts with finding out what existing Cameo connectors and matching features already handle.</p>

    <h2>Design: 50 distinct, labeled synthetic cases</h2>
    <p>Hold 20 cases for tuning criteria and thresholds and 30 for evaluation. The held-out 30 stay untouched until the criteria are frozen. The case counts below are a proposal.</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Category</th><th class="num">Cases</th><th>What it probes</th></tr></thead>
      <tbody>${mix.map(([c, n, d]) => `<tr><td>${c}</td><td class="num">${n}</td><td>${d}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td>Total</td><td class="num">${mix.reduce((s, r) => s + r[1], 0)}</td><td></td></tr></tfoot>
    </table></div>

    <h2>Arms compared</h2>
    <ul>
      <li><strong>Rules:</strong> structured-field and keyword matching, the cheapest honest baseline.</li>
      <li><strong>Conventional LLM:</strong> a general model given the same rubric and the same narrow inputs.</li>
      <li><strong>Jev:</strong> pinned to <code>jev-1.13.0</code>, with the version recorded against every result.</li>
    </ul>
    <p>All three arms run behind the same deterministic checks and the same engineer review screen. Only the semantic step changes.</p>

    <h2>Measures</h2>
    <dl class="defs">${metrics.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
    <p>Calibrate confidence against the labeled tuning cases before choosing any threshold. A permitted output can still be the wrong answer.</p>

    <h2>Decision rule</h2>
    <p class="callout">Provisional pilot target: <strong>at least 25% lower median review time</strong> with <strong>no increase in incorrect accepted links</strong>, compared with the best non-Jev arm.</p>
    <p>Fifty cases can guide the next experiment. They cannot establish production assurance.</p>

    <h2>Stop if</h2>
    <ul>
      <li>Reviewers accept bad links more often when shown the model’s suggestion, i.e. the tool biases them.</li>
      <li>An existing connector or matching feature already covers the need.</li>
      <li>The model cannot run within the deployment environment’s data-handling and access constraints.</li>
      <li>The time saved does not justify integration and operating cost.</li>
    </ul>
  </div>`
}

export function renderNotes() {
  const rows = [
    ['Chief Software Architect', 'Salesforce secure delivery, OPA policy work and control-coverage mapping; SRI provenance and governed writes', 'Keep authoritative records, interpretation, authorization and execution distinct.'],
    ['Lead Software Developer', 'Zillow Lambda/Step Functions pipelines; Stimulus recovery and engineering-team rebuild', 'Turn the design into a small API, observable failures, bounded retries and useful code-review criteria.'],
    ['Innovation & R&D', 'Production FIFA vendor intake; separately, SRI customer-beta agent workflows', 'Compare a new model with existing methods and justify adoption through measured user benefit.'],
  ]
  const three = CASES.filter((c) => ['obvious', 'ambiguous', 'obsolete'].includes(c.id))
  return `
  <div class="prose">
    <h2>Answer to rehearse</h2>
    <p class="muted">For: “What recent AI development would you investigate for our integration work?”</p>
    <blockquote>I’m following Jev because it makes bounded judgments cheap enough to consider throughout a workflow. Given your Cameo integration context, I’d investigate whether it can help engineers identify relevant evidence across systems. I’d preserve source IDs and revisions, use code for exact checks and permissions, and keep uncertain relationships under review. That connects to my work on policy coverage, provenance and governed actions. I’d compare it with rules and a conventional model, then measure reviewer time and incorrect accepted links. I’d proceed only if the improvement justified the integration and operating cost.</blockquote>
    <p>Anchor it with one example. The <em>obsolete revision</em> case works well: the meaning matches and the report says PASS, but it was tested against rev B, so code blocks the link.</p>

    <h2>Question for Gus</h2>
    <blockquote class="ask">Which links between the model and external data still require an engineer to interpret meaning, and what makes a link trustworthy enough to accept?</blockquote>

    <h2>Three pairs: who decides what</h2>
    <div class="table-wrap"><table class="split">
      <thead><tr><th>Case</th><th><span class="lane-dot code"></span>Code decides</th><th><span class="lane-dot model"></span>Jev might judge</th><th><span class="lane-dot eng"></span>Engineer approves</th></tr></thead>
      <tbody>${three.map((c) => `<tr><th scope="row">${esc(c.label)}</th><td>${esc(c.split.code)}</td><td>${esc(c.split.model)}</td><td>${esc(c.split.engineer)}</td></tr>`).join('')}</tbody>
    </table></div>

    <h2>Experience to bring forward</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>Responsibility</th><th>Experience</th><th>Judgment the Jev example shows</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><th scope="row">${r[0]}</th><td>${r[1]}</td><td>${r[2]}</td></tr>`).join('')}</tbody>
    </table></div>

    <h2>Keep these distinctions</h2>
    <ul>
      <li>FIFA intake was <strong>production</strong> work. SRI was a <strong>customer beta</strong>. Jev is something you are <strong>investigating</strong>.</li>
      <li>Salesforce control mapping is an analogy for connecting evidence to criteria. It did not automate certification.</li>
      <li>The Cameo application is a <strong>proposed</strong> investigation, not a confirmed KBR need or deployment.</li>
      <li>The launch demos (game decisions, Wikipedia navigation) show the approach, not readiness for engineering systems.</li>
      <li>LangChain’s evaluation reported 0.44 s and $0.00035 per call, using five weather-agent examples. That is limited evidence about engineering accuracy.</li>
    </ul>

    <h2>HR screen</h2>
    <p>Lead with shipped AI work and leadership examples. Keep Jev to a short illustration of how you stay current, and save the architecture detail for Gus.</p>

    <h2>Sources referenced in the brief</h2>
    <ul class="sources">
      <li>TypeSafe launch announcement, Sep 15</li>
      <li>LangChain integration: model routing and tool-call screening, Sep 17</li>
      <li>Jev 1.13 limitations page, last reviewed Sep 17: arithmetic and date comparisons, distracting context, adversarial instructions</li>
      <li>LangChain agent-evaluation experiment, Sep 20</li>
      <li>Current model reference and version guidance, accessed Sep 20: explicit ID <code>jev-1.13.0</code></li>
    </ul>
  </div>`
}
