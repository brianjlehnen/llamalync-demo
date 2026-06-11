const { manageClient } = require('../http/vantaClient');
const logger = require('../utils/logger');

/**
 * Fetch all people who have overdue security training tasks.
 * Great for showing customers the "people risk" view.
 */
async function getPeopleWithOverdueTasks() {
  logger.debug('Fetching people with overdue security tasks...');
  const people = await manageClient.fetchAllPages('/v1/people', {
    hasOverdueSecurityTasks: true
  });
  logger.info('People with overdue tasks', { count: people.length });
  return people;
}

/**
 * Fetch failing tests across all frameworks.
 * The backbone of a compliance status dashboard.
 */
async function getFailingTests() {
  logger.debug('Fetching failing tests...');
  const tests = await manageClient.fetchAllPages('/v1/tests', {
    outcome: 'FAIL'
  });
  logger.info('Failing tests', { count: tests.length });
  return tests;
}

/**
 * Build the query-params for the SLA-approaching vulnerability fetch.
 *
 * Pure function — exposed so tests can verify the filter shape without
 * mocking the HTTP client. The prior code only sent
 * `remediationDeadlineBefore: <now+N days>` with no lower bound, so the
 * result mixed already-breached SLAs with approaching-but-not-yet ones.
 * "Approaching SLA" is supposed to mean "soon, not yet, not past" —
 * already-breached vulns belong in a separate overdue-list, not here.
 *
 * Both bounds use the same `now` instant so they can't drift if the
 * second `new Date()` lands a millisecond later.
 */
function buildSLAQueryParams(daysAhead, now = new Date()) {
  const deadline = new Date(now);
  deadline.setDate(deadline.getDate() + daysAhead);
  return {
    status: 'OPEN',
    remediationDeadlineAfter:  now.toISOString(),
    remediationDeadlineBefore: deadline.toISOString()
  };
}

/**
 * Fetch vulnerabilities approaching their SLA deadline (within N days).
 * Excludes already-breached vulns via the After bound.
 */
async function getVulnerabilitiesApproachingSLA(daysAhead = 7) {
  logger.debug(`Fetching vulnerabilities due within ${daysAhead} days...`);

  const params = buildSLAQueryParams(daysAhead);
  const vulns = await manageClient.fetchAllPages('/v1/vulnerabilities', params);

  logger.info('Vulnerabilities approaching SLA', { count: vulns.length, daysAhead });
  return vulns;
}

/**
 * Fetch all controls.
 *
 * Note: `/v1/controls` returns the *requirements* themselves (id, name,
 * description, domains, source) — NOT pass/fail outcomes. Outcome lives on
 * `/v1/tests`, which evaluate against controls. Auditors look at controls
 * to know what's required; they look at tests to know what's working.
 */
async function getControlsStatus() {
  logger.debug('Fetching controls...');
  const controls = await manageClient.fetchAllPages('/v1/controls');

  const bySource = controls.reduce((acc, c) => {
    const key = c.source || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const summary = { total: controls.length, bySource };
  logger.info('Controls summary', summary);
  return { controls, summary };
}

/**
 * Compliance health snapshot for the dashboard.
 *
 * Uses allSettled so a single failing endpoint doesn't blank the whole
 * dashboard — important for live demos where one slice of the read API
 * may be unhappy. Each section reports either data or an error string.
 */
async function getComplianceSnapshot() {
  const [overduePeople, failingTests, approachingVulns, controlsData] = await Promise.allSettled([
    getPeopleWithOverdueTasks(),
    getFailingTests(),
    getVulnerabilitiesApproachingSLA(7),
    getControlsStatus()
  ]);

  const settle = (result, onValue) =>
    result.status === 'fulfilled'
      ? onValue(result.value)
      : { error: result.reason?.message || 'unknown error' };

  return {
    generatedAt: new Date().toISOString(),
    people: settle(overduePeople, v => ({ overdueTaskCount: v.length, people: v })),
    tests: settle(failingTests, v => ({ failingCount: v.length, tests: v })),
    vulnerabilities: settle(approachingVulns, v => ({ approachingSLACount: v.length, vulns: v })),
    controls: settle(controlsData, v => v.summary)
  };
}

module.exports = {
  getPeopleWithOverdueTasks,
  getFailingTests,
  getVulnerabilitiesApproachingSLA,
  getControlsStatus,
  getComplianceSnapshot,
  buildSLAQueryParams
};
