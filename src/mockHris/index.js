const express = require('express');
const path = require('path');
const fs = require('fs');
const { safeLoadJson } = require('../utils/safeLoadJson');

/**
 * Fake "People-X" HRIS — stands in for a customer's bespoke HR system that
 * Vanta has no native connector for. Holds an in-memory mutation
 * layer over the baseline JSON file so the dashboard can demonstrate live
 * Hire and Offboard flows without touching the source-of-truth file.
 *
 * Mutations reset on server restart by design — demo prop, not persistent.
 *
 * Promotion path: when LlamaLync deploys, /mock-peoplex deploys with it.
 * For a real customer integration, swap loadEmployees() to fetch from the
 * customer's API or bucket.
 */
const router = express.Router();
const EMPLOYEES_FILE = path.join(__dirname, '../../mock-data/employees.json');

// Pool of plausible new hires. Cycled through on each Hire click.
const NEW_HIRE_POOL = [
  { firstName: 'Eve',    lastName: 'Patel',    title: 'Software Engineer',    department: 'Engineering' },
  { firstName: 'Frank',  lastName: 'Reyes',    title: 'Senior Designer',      department: 'Design' },
  { firstName: 'Grace',  lastName: 'Liu',      title: 'Product Manager',      department: 'Product' },
  { firstName: 'Henry',  lastName: 'Kim',      title: 'Customer Success Mgr', department: 'CX' },
  { firstName: 'Iris',   lastName: 'Mueller',  title: 'Account Executive',    department: 'Revenue' },
  { firstName: 'Jack',   lastName: 'Romano',   title: 'Marketing Manager',    department: 'Marketing' },
  { firstName: 'Kira',   lastName: 'Patel',    title: 'Data Analyst',         department: 'Analytics' },
  { firstName: 'Luis',   lastName: 'Vega',     title: 'Security Engineer',    department: 'Security' }
];

// Mutation state — lives only in memory, resets on restart.
let mutations = {
  added: [],         // brand-new employees beyond the file
  statusChanges: {}, // { 'emp-001': { status: 'terminated', terminationDate: 'YYYY-MM-DD' } }
  hireCounter: 0     // monotonic counter for unique IDs across the demo session
};

function loadEmployees() {
  const stat = fs.statSync(EMPLOYEES_FILE);
  const baseline = safeLoadJson(EMPLOYEES_FILE);

  const applyChanges = (e) => {
    const change = mutations.statusChanges[e.id];
    return change ? { ...e, ...change } : e;
  };

  const data = [...baseline.map(applyChanges), ...mutations.added.map(applyChanges)];
  return { data, lastModified: stat.mtime.toISOString(), mutationCount: countMutations() };
}

function countMutations() {
  return mutations.added.length + Object.keys(mutations.statusChanges).length;
}

function hire() {
  const idx = mutations.hireCounter % NEW_HIRE_POOL.length;
  const cycle = Math.floor(mutations.hireCounter / NEW_HIRE_POOL.length);
  mutations.hireCounter++;

  const template = NEW_HIRE_POOL[idx];
  const suffix = cycle > 0 ? `-${cycle}` : '';
  const id = `emp-new-${String(mutations.hireCounter).padStart(3, '0')}`;
  const employee = {
    id,
    firstName: template.firstName,
    lastName: template.lastName + suffix,
    email: `${template.firstName.toLowerCase()}.${template.lastName.toLowerCase()}${suffix}@peoplex.example.com`,
    title: template.title,
    department: template.department,
    startDate: new Date().toISOString().split('T')[0],
    status: 'active',
    isServiceAccount: false,
    managerId: 'emp-010'
  };
  mutations.added.push(employee);
  return employee;
}

function offboard(id) {
  const { data } = loadEmployees();
  const employee = data.find(e => e.id === id);
  if (!employee) return { ok: false, status: 404, error: 'Employee not found' };
  if (employee.status === 'terminated') {
    return { ok: false, status: 409, error: 'Already offboarded' };
  }

  mutations.statusChanges[id] = {
    status: 'terminated',
    terminationDate: new Date().toISOString().split('T')[0]
  };
  return { ok: true, employee: { id, ...mutations.statusChanges[id] } };
}

function resetMutations() {
  mutations = { added: [], statusChanges: {}, hireCounter: 0 };
}

// ─── Routes ────────────────────────────────────────────────────────────────

router.get('/mock-peoplex/employees.json', (req, res) => {
  const { data } = loadEmployees();
  res.json(data);
});

router.get('/mock-peoplex/_meta.json', (req, res) => {
  const { data, lastModified, mutationCount } = loadEmployees();
  res.json({
    source: 'People-X — simulated bespoke HRIS',
    served: 'GET /mock-peoplex/employees.json',
    sourceFile: 'mock-data/employees.json',
    lastModified,
    sessionMutations: mutationCount,
    totalRecords: data.length,
    breakdown: {
      activeEmployees: data.filter(e => e.status === 'active' && !e.isServiceAccount).length,
      terminated: data.filter(e => e.status === 'terminated').length,
      serviceAccounts: data.filter(e => e.isServiceAccount).length
    }
  });
});

// JSON body parsing for the mutation routes (the global parser is registered
// AFTER the routers in index.js to avoid breaking the webhook raw body path).
router.use(express.json());

router.post('/mock-peoplex/employees', (req, res) => {
  const employee = hire();
  res.status(201).json(employee);
});

router.post('/mock-peoplex/employees/:id/offboard', (req, res) => {
  const result = offboard(req.params.id);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json(result.employee);
});

router.post('/mock-peoplex/reset', (req, res) => {
  resetMutations();
  res.json({ ok: true });
});

module.exports = {
  router,
  loadEmployees,
  // Exposed for the /demo/reset/personnel workflow + tests
  _resetMutations: resetMutations
};
