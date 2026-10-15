/**
 * The TypeSafe example - a governed client that is not a chat.
 *
 * The other examples beside this one share a chat script, because Anthropic, OpenAI and
 * OpenRouter all answer one turn at a time. TypeSafe does not: one `systemOne` call carries a
 * document and a whole set of typed questions and comes back, once, with every answer and a
 * single usage record. So this file runs the governed call itself - and the integration is still
 * only the two lines the chat script uses, `stigg.wrap()` and `run.start()`.
 *
 * The questions are the GDPR set from TypeSafe's parallel-questions cookbook - 8 nouls, 2 choices
 * and 3 scores - and `--split` is what makes this worth running under a budget. The cookbook's
 * claim is that asking the questions one at a time costs an order of magnitude more for the same
 * answers, because the document is re-sent with every question. Under governance that stops being
 * a benchmark and becomes a wallet: the batched run spends about one document, the split run
 * spends thirteen, and the budget denies it partway through.
 *
 *   yarn example-client-typesafe
 *   yarn example-client-typesafe --split
 *
 * A TypeSafe key is required - the built-in vendor mock speaks the chat wire formats, not this
 * one. Stigg still falls back to its own mock, so this runs with no Stigg account.
 */
import '../shared/load-env';
import { choice, noul, score, TypeSafeClient } from '@typesafe-ai/sdk';
import { StiggAgentSDK, normalizeUsage } from '../../src';
import { maybeStartMockStiggServer } from '../shared/mock-stigg-server';
import { seedMock } from '../shared/setup-governance';
import { agentIdFor, describeSetup, resolveDemoEnv, type DemoEnv } from '../shared/demo-env';
import { requireKey, resolveStiggEnv, type StiggEnv } from '../shared/stigg-env';
import { optionalEnv } from './core/vendor';

const MODEL = process.env.AGENT_SDK_TYPESAFE_MODEL ?? 'jev-latest';
const ARTICLE = 'General Data Protection Regulation';
/**
 * Credits per agent, per window. Sized so the point lands: one batched call fits comfortably,
 * and the split run - the same thirteen questions, one document each - does not.
 */
const AGENT_BUDGET = 60;
/** ISO-8601 single-unit duration. Governance requires a cadence whenever it creates a budget. */
const BUDGET_CADENCE = 'P1M';

/**
 * The document under question. Pinned to a revision when one is given, so a run is reproducible;
 * left at the current revision otherwise, and the id that actually served is printed either way.
 */
async function fetchArticle(revision?: string): Promise<{ source: string; text: string; revid: number }> {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    prop: 'extracts|revisions',
    rvprop: 'ids',
    explaintext: '1',
    origin: '*',
  });
  if (revision) params.set('revids', revision);
  else params.set('titles', ARTICLE);

  const response = await fetch(`https://en.wikipedia.org/w/api.php?${params}`);
  if (!response.ok) throw new Error(`Wikipedia returned ${response.status}`);

  // `fetch` types the body as `unknown`; the shape is Wikipedia's, checked on the next line.
  const page = ((await response.json()) as any)?.query?.pages?.[0];
  const revid = page?.revisions?.[0]?.revid;
  if (!page?.extract || !revid) throw new Error(`No article text for "${revision ?? ARTICLE}"`);

  return { source: `https://en.wikipedia.org/?oldid=${revid}`, text: page.extract, revid };
}

/**
 * 8 nouls + 2 choices + 3 scores, asked in one call.
 *
 * The mix is deliberate: a noul answers with a probability, a choice with a label and a
 * distribution over the labels, a score with a position on a scale you defined. Three different
 * answer types, one request, one usage record.
 */
const QUESTIONS = {
  breach_72h: noul('Must a personal data breach be reported to the supervisory authority within 72 hours?'),
  applies_non_eu: noul(
    'Does the regulation apply to organisations established outside the EU that offer goods or services to people in the EU?',
  ),
  dpo_all_orgs: noul(
    'Must every organisation appoint a Data Protection Officer, regardless of what data it processes?',
  ),
  pre_ticked_consent: noul('Can valid consent be obtained through pre-ticked boxes or inactivity?'),
  right_erasure: noul('Does the regulation grant individuals a right to erasure of their personal data?'),
  data_portability: noul('Does the regulation include a right to data portability?'),
  us_federal_law: noul('Is the GDPR a United States federal law?'),
  criminal_penalties: noul('Does the GDPR itself impose criminal penalties such as imprisonment?'),

  instrument_type: choice('What kind of EU legal instrument is the GDPR?', {
    Regulation: 'Directly binding law in all member states, no national implementation needed.',
    Directive: 'Sets goals that member states implement through national law.',
    Treaty: 'An international treaty between states.',
    Recommendation: 'Non-binding guidance.',
  }),
  max_fine: choice('What is the maximum administrative fine for the most serious infringements?', {
    TwentyM_or_4pct: 'Up to EUR 20 million or 4% of annual worldwide turnover, whichever is greater.',
    TenM_or_2pct: 'Up to EUR 10 million or 2% of annual worldwide turnover, whichever is greater.',
    FixedCap: 'A fixed amount not tied to turnover.',
    NoFines: 'The GDPR provides no administrative fines.',
  }),

  individual_rights: score('How strong are the rights the GDPR grants to individuals over their data?', [
    'None: individuals get no rights over their data.',
    'Weak: a right to be informed, but little control.',
    'Moderate: access and correction rights, but limited means to act on them.',
    'Strong: access, erasure, portability, and objection rights, with enforcement behind them.',
  ]),
  penalty_severity: score('How severe are the penalties the GDPR provides for non-compliance?', [
    'None: no penalties of any kind.',
    'Symbolic: small fixed fines unlikely to change behavior.',
    'Substantial: fines large enough to matter to most companies.',
    'Severe: fines scaled to global revenue, material even to the largest companies.',
  ]),
  compliance_burden: score('How heavy is the compliance burden the GDPR places on organisations?', [
    'Negligible: no meaningful obligations.',
    'Light: a few notices and disclosures.',
    'Moderate: documented processes and some dedicated roles for larger processors.',
    'Heavy: records, impact assessments, officers, and breach procedures for many organisations.',
    'Extreme: obligations so demanding that ordinary organisations cannot fully comply.',
  ]),
};

/**
 * Every answer type onto one 0..1 axis, so thirteen questions print as one table. A noul is
 * already a probability; a choice reports the confidence behind the label it picked; a score is a
 * rung on its own ladder, so it divides by the number of gaps between rungs.
 */
function normalizeAnswer(answer: any): { value: number; label: string } {
  if (answer.type === 'noul') return { value: answer.noul, label: answer.noul >= 0.5 ? 'yes' : 'no' };
  if (answer.type === 'choice') return { value: answer.confidence, label: answer.choice };
  const rungs = Object.keys(answer.probabilities).length;
  return { value: answer.score / (rungs - 1), label: answer.legend?.[answer.score] ?? String(answer.score) };
}

/** Everything the governance side needs, before a single question is asked. */
async function startGovernance(env: StiggEnv, demoEnv: DemoEnv) {
  const stiggMock = await maybeStartMockStiggServer(env.offline);
  // The account's own setup: entity types, the parent team, a funded pool. Not the agent - that
  // is this application's to provision, in `agentOptions` below.
  if (stiggMock) {
    await seedMock(demoEnv, stiggMock, {
      agents: [],
      teamLimit: AGENT_BUDGET * 2,
      // The pool must dwarf the per-agent budget, or a denial would come from an empty wallet
      // rather than from the budget this example is about.
      poolMin: AGENT_BUDGET * 4,
      log: () => undefined,
    });
  }
  return stiggMock;
}

/** Prints the answers to one call. */
function printAnswers(answers: Record<string, any>): void {
  for (const [key, answer] of Object.entries(answers)) {
    const { value, label } = normalizeAnswer(answer);
    const bar = '#'.repeat(Math.round(value * 20)).padEnd(20, '.');
    console.log(`  ${key.padEnd(20)} ${bar} ${value.toFixed(2)}  ${label}`);
  }
}

async function main(): Promise<void> {
  const apiKey = optionalEnv('AGENT_SDK_TYPESAFE_API_KEY', 'TYPESAFE_API_KEY');
  if (!apiKey) throw new Error('Set AGENT_SDK_TYPESAFE_API_KEY (or TYPESAFE_API_KEY) to run this example.');

  // One call carrying all thirteen questions, or thirteen calls carrying one each.
  const split = process.argv.includes('--split');
  // `env` is what any application has - which Stigg to talk to. `demoEnv` is what only a demo
  // reads from a file: the tenant, the agent, what to gate on.
  const env = resolveStiggEnv();
  const demoEnv: DemoEnv = resolveDemoEnv(env);

  const stiggMock = await startGovernance(env, demoEnv);
  console.log(`[governance] ${describeSetup(env, demoEnv)}`);

  // The mock when one is running, the configured key otherwise - one argument, because it is
  // one choice.
  const stigg = stiggMock
    ? new StiggAgentSDK({ baseUrl: stiggMock.baseUrl })
    : new StiggAgentSDK({ apiKey: requireKey(env), baseUrl: env.baseUrl });

  // The agent this analysis spends as. No AGENT_SDK_DEMO_AGENT_ID (or no agent type) and there is
  // no agent: the calls are checked against the customer's own pool instead.
  const typesafeAgentId = demoEnv.agentType ? agentIdFor(demoEnv, 'typesafe') : undefined;

  // Provisioning the agent is a write, so it is its own call rather than something a call carries.
  if (typesafeAgentId && demoEnv.agentType) {
    await stigg.register({
      customerId: demoEnv.customerId,
      agentId: typesafeAgentId,
      entityTypeId: demoEnv.agentType.entityTypeId,
      displayName: 'TypeSafe document analysis',
      // `null` rather than undefined: no team means this agent is a root, not one whose existing
      // parent should be left alone.
      ...(demoEnv.entitlement
        ? {
            budget: {
              entitlement: demoEnv.entitlement,
              parentId: demoEnv.teamId ?? null,
              limit: AGENT_BUDGET,
              apply: 'on-create' as const,
              cadence: BUDGET_CADENCE,
            },
          }
        : {}),
    });
  }

  // The client is built exactly as it would be without Stigg. The one line after it is the whole
  // integration - every `systemOne` below is checked before the request and metered after.
  const typesafe = new TypeSafeClient({ apiKey, timeout: 120_000 });
  const govClient = stigg.wrap(typesafe, {
    stiggContext: {
      customerId: demoEnv.customerId,
      agentId: typesafeAgentId,
      attributionKey: demoEnv.agentType?.attributionKey,
      entitlement: demoEnv.entitlement,
      eventName: demoEnv.ingestEventName,
      // No `usageMapper`: the calls report TypeSafe's own two counters under TypeSafe's own names,
      // which is what reconciles against its invoice. To bill your own number instead, price them:
      //
      //   usageMapper: weightedMetrics(typesafeRecipe, 'answer_credit', { input_tokens: 1, output_tokens: 5 }, { per: 1000 }),
      //
      // and note there is no cache counter to weight here - see the recipe for why.
    },
    hooks: {
      onDecision: (decision) => console.log(`[governance] check ${decision.summary}`),
      onIngest: (result) =>
        console.log(
          `[governance] ingest ${Object.entries(result.reported)
            .map(([name, value]) => `${name}=${value}`)
            .join(' ')} ok=${result.ok}` +
            `${result.creditsConsumed !== undefined ? ` credits=${Math.round(result.creditsConsumed * 100) / 100}` : ''}`,
        ),
    },
  });

  const article = await fetchArticle(process.env.AGENT_SDK_TYPESAFE_REVISION);
  const keys = Object.keys(QUESTIONS) as (keyof typeof QUESTIONS)[];
  // Batched: one call with every question. Split: one call per question, each re-sending the
  // whole document - which is the entire cost difference the cookbook measures.
  const batches = split ? keys.map((key) => [key]) : [keys];

  console.log(
    `\nTypeSafe  model=${MODEL}  article=r${article.revid}  questions=${keys.length}  ` +
      `calls=${batches.length}${split ? '  (--split)' : ''}\n`,
  );

  let calls = 0;
  let input = 0;
  let output = 0;
  const started = performance.now();

  for (const batch of batches) {
    const questions = Object.fromEntries(batch.map((key) => [key, QUESTIONS[key]]));
    try {
      const response = await govClient.systemOne({ state: { article }, questions, model: MODEL });
      calls += 1;
      // The wrapper read this same object and ingested it; normalizing it here with the SDK's own
      // function shows the printed numbers are the ones that were metered.
      const usage = normalizeUsage(response.usage);
      input += usage.input;
      output += usage.output;
      printAnswers(response.answers as Record<string, any>);
    } catch (err) {
      const decision = stigg.denial(err);
      if (!decision) throw err;

      // The request never left the process, so these questions were never asked - and never paid
      // for. That is the difference between a budget and an invoice you read afterwards.
      console.log(`\n  ${decision.message}`);
      console.log(`  Denied after ${calls} of ${batches.length} calls. Raise the budget with:`);
      console.log(`    yarn example-setup --agent-limit ${AGENT_BUDGET * 8}`);
      break;
    }
  }

  const elapsed = (performance.now() - started) / 1000;
  console.log(`\n  ${calls} call(s): ${input} in / ${output} out  in ${elapsed.toFixed(1)}s`);

  const summary = await govClient.stigg.flush();
  await stigg.flush({ close: true });
  await stiggMock?.close();

  console.log(
    `[governance] checks=${summary.checks} ingested=${summary.ingested} ` + `failed_ingests=${summary.ingestFailures}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
