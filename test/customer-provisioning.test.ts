/**
 * `defaultPlanId`: a customer Stigg has never seen is created on that plan by their first call,
 * and a customer it already knows is left exactly as they are.
 *
 * Assertions read `provisionAttempts` - every mutation the SDK sent, refused or not - rather than
 * what was stored. The mock refuses a duplicate the way Stigg does, so a store-side assertion
 * would pass whether or not the SDK repeated itself.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { noopLogger } from '../src/logger';
import { context, newStigg } from './stigg-harness';
import type { StiggAgentSDK } from '../src/stigg-agent-sdk';

/** Moves a failed customer's next attempt to now, rather than sleeping through the wait. */
const retryAt = (stigg: StiggAgentSDK, afterMs: number) => {
  (stigg as unknown as { provisionRetryAfterMs: number }).provisionRetryAfterMs = afterMs;
  for (const key of (stigg as unknown as { provisionRetryAt: Map<string, number> }).provisionRetryAt.keys()) {
    (stigg as unknown as { provisionRetryAt: Map<string, number> }).provisionRetryAt.set(key, Date.now() + afterMs);
  }
};

const plan = 'plan-free';
const newCustomer = { ...context, customerId: 'customer-new', defaultPlanId: plan };

describe('a default plan provisions the customers Stigg does not know', () => {
  it('creates a new customer on the plan before their first check', async () => {
    const { stigg, mock } = await newStigg();
    await stigg.check(newCustomer);
    assert.deepEqual(mock.state.provisionAttempts, ['customer-new']);
    assert.deepEqual(mock.state.subscriptionWrites, [{ customerId: 'customer-new', planId: plan }]);
  });

  it('reads an existing customer refused as a duplicate as existing, not as a failure', async () => {
    const errors: unknown[] = [];
    const { stigg, mock } = await newStigg({ onError: (error) => errors.push(error) });
    const decision = await stigg.check({ ...context, defaultPlanId: plan });
    assert.deepEqual(errors, []);
    assert.equal(decision.hasAccess, true, 'the funded customer is answered as themselves');
    assert.deepEqual(mock.state.subscriptionWrites, []);
  });

  it('asks once per customer, however many calls arrive together or after', async () => {
    const { stigg, mock } = await newStigg();
    await Promise.all([stigg.check(newCustomer), stigg.check(newCustomer), stigg.check(newCustomer)]);
    await stigg.check(newCustomer);
    assert.deepEqual(mock.state.provisionAttempts, ['customer-new']);
  });

  it('provisions on a report too, which is the first call a metering-only client makes', async () => {
    const { stigg, mock } = await newStigg();
    await stigg.report({ customerId: 'customer-new', defaultPlanId: plan, ingestMode: 'sync' }, { credits: 1 });
    assert.deepEqual(mock.state.subscriptionWrites, [{ customerId: 'customer-new', planId: plan }]);
  });

  it('provisions nobody when no plan is named', async () => {
    const { stigg, mock } = await newStigg();
    await stigg.check({ ...context, customerId: 'customer-new' });
    assert.deepEqual(mock.state.provisionAttempts, []);
  });

  it('takes the plan from the wrap and the customer from the call', async () => {
    const { stigg, mock } = await newStigg();
    const client = stigg.wrap(
      { messages: { create: async () => ({ usage: { input_tokens: 0 } }), stream: () => undefined } },
      { stiggContext: { entitlement: context.entitlement, defaultPlanId: plan } },
    );
    await client.stigg.check({ customerId: 'customer-new' });
    assert.deepEqual(mock.state.subscriptionWrites, [{ customerId: 'customer-new', planId: plan }]);
  });

  it('warns when the server put the customer somewhere other than the plan asked for', async () => {
    const warnings: string[] = [];
    const { stigg, mock } = await newStigg({ logger: { ...noopLogger, warn: (message) => warnings.push(message) } });
    mock.provisionDecision = 'PREDEFINED_FREE_PLAN';
    await stigg.check(newCustomer);
    assert.equal(warnings.filter((warning) => warning.includes('not on plan plan-free')).length, 1);
  });
});

describe('a provisioning that fails', () => {
  // Every code Stigg answers is final except the few that say nothing about the customer. One
  // missing from either list would be a regression the reviewer found by hand: a key that cannot
  // write, retried on every call while the error policy let each call through.
  for (const code of [
    'PlanNotFound',
    'EntityIsArchivedError',
    'AccessDeniedError',
    'BadUserInput',
    'IdentityForbidden',
  ]) {
    it(`remembers ${code} as final - asked once, and every check refused`, async () => {
      const { stigg, mock } = await newStigg();
      mock.failProvisioning = { code };
      mock.strictCustomers = true;
      const decisions = [];
      for (let i = 0; i < 3; i++) decisions.push(await stigg.check({ ...newCustomer, checkErrorAction: 'allow' }));
      assert.deepEqual(mock.state.provisionAttempts, ['customer-new']);
      assert.ok(decisions.every((decision) => !decision.hasAccess));
    });
  }

  for (const code of [
    'RateLimitExceeded',
    'OperationTimeout',
    'UnexpectedError',
    'ObjectAlreadyBeingUsedByAnotherRequestError',
  ]) {
    it(`retries ${code} once its wait is over - and not before`, async () => {
      const { stigg, mock } = await newStigg();
      mock.failProvisioning = { code };
      mock.strictCustomers = true;
      for (let i = 0; i < 5; i++) await stigg.check(newCustomer);
      assert.deepEqual(mock.state.provisionAttempts, ['customer-new'], 'one attempt while Stigg is failing');

      retryAt(stigg, 0);
      mock.failProvisioning = false;
      await stigg.check(newCustomer);
      await stigg.check(newCustomer);
      assert.deepEqual(mock.state.subscriptionWrites, [{ customerId: 'customer-new', planId: plan }]);
    });
  }

  // Stigg answered, and will answer the same way next time - so it is asked once, reported once,
  // and the check answers for the customer that does not exist. An `allow` policy exists for
  // outages; waving every new customer through on a typo'd plan id is not what it is for.
  it('is refused, reported once and not retried, when Stigg rejects it', async () => {
    const errors: unknown[] = [];
    const { stigg, mock } = await newStigg({ onError: (error) => errors.push(error) });
    mock.failProvisioning = 'rejected';
    mock.strictCustomers = true;
    const decisions = [];
    for (let i = 0; i < 3; i++) decisions.push(await stigg.check({ ...newCustomer, checkErrorAction: 'allow' }));
    assert.deepEqual(mock.state.provisionAttempts, ['customer-new']);
    assert.equal(errors.length, 1);
    assert.ok(decisions.every((decision) => !decision.hasAccess));
  });

  // Stigg did not answer, and the check found no customer: the one case where the call is not
  // about the customer at all, so the configured policy decides it.
  for (const checkErrorAction of ['allow', 'deny'] as const) {
    it(`answers with the '${checkErrorAction}' policy when Stigg is unreachable for a new customer`, async () => {
      const { stigg, mock } = await newStigg();
      mock.failProvisioning = 'unreachable';
      mock.strictCustomers = true;
      const decision = await stigg.check({ ...newCustomer, checkErrorAction });
      assert.equal(decision.hasAccess, checkErrorAction === 'allow');
    });
  }

  it('answers an existing customer as themselves when the create could not reach Stigg', async () => {
    const { stigg, mock } = await newStigg();
    mock.failProvisioning = 'unreachable';
    mock.strictCustomers = true;
    const decision = await stigg.check({ ...context, defaultPlanId: plan, checkErrorAction: 'deny' });
    assert.equal(decision.hasAccess, true, 'the real answer, not the deny policy');
  });

  // The review case: a rate limit arrives as a GraphQL error code, just like a refusal. Remembered
  // as one, it would deny every check for that customer until the process restarted.
  it('is retried, not remembered as a refusal, when Stigg rate-limits it', async () => {
    const errors: unknown[] = [];
    const { stigg, mock } = await newStigg({ onError: (error) => errors.push(error) });
    retryAt(stigg, 0);
    mock.failProvisioning = 'rate-limited';
    mock.strictCustomers = true;
    const limited = await stigg.check({ ...newCustomer, checkErrorAction: 'allow' });
    assert.equal(limited.hasAccess, true, 'a passing failure is the error policy, not a verdict');
    assert.equal(
      errors.filter((error) => String(error).includes('will not be asked again')).length,
      0,
      'not reported as a final refusal',
    );

    mock.failProvisioning = false;
    await stigg.check(newCustomer);
    assert.deepEqual(mock.state.subscriptionWrites, [{ customerId: 'customer-new', planId: plan }]);
    assert.equal(mock.state.provisionAttempts.filter((id) => id === 'customer-new').length >= 2, true, 'asked again');
  });

  it('is retried by the next call when Stigg was unreachable', async () => {
    const { stigg, mock } = await newStigg();
    retryAt(stigg, 0);
    mock.failProvisioning = 'unreachable';
    mock.strictCustomers = true;
    await stigg.check(newCustomer);
    // The Node SDK retries a 503 on its own, so one failed provisioning is several requests.
    const failed = mock.state.provisionAttempts.length;
    mock.failProvisioning = false;
    await stigg.check(newCustomer);
    assert.equal(mock.state.provisionAttempts.length, failed + 1);
    assert.deepEqual(mock.state.subscriptionWrites, [{ customerId: 'customer-new', planId: plan }]);
  });
});
