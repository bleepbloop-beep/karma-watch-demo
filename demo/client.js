/**
 * In-memory stand-in for the small part of the Supabase client the dashboard
 * uses. It lets the demo run the real UI code with no account, network, or
 * database. Everything resets on page reload.
 */
function createDemoClient(demoData, { now = Date.now() } = {}) {
  const HOUR = 60 * 60 * 1000;
  const iso = (hoursAgo) => new Date(now - hoursAgo * HOUR).toISOString();
  const user = { id: "demo-user", email: "Demo workspace" };
  let nextId = 1;

  const toThread = ({ hours_ago: hoursAgo, ...row }) => ({
    id: `thread-${nextId++}`,
    user_id: user.id,
    status: "new",
    url: null, // fictional posts must never link to a real thread
    created_utc: iso(hoursAgo),
    detected_at: iso(Math.max(0, hoursAgo - 0.2)),
    ...row,
  });

  const tables = {
    monitors: demoData.monitors.map((row, index) => ({
      user_id: user.id, active: true, email_alerts: false, industry: "energy",
      created_at: iso(2000 - index), last_scanned_at: iso(0.1), ...row,
    })),
    threads: demoData.threads.map(toThread),
  };
  const pending = [...demoData.scan_results];

  // Minimal thenable query builder: from(t).select().order().limit(), etc.
  function from(table) {
    const query = { action: "select", payload: null, filters: [], sort: null, max: null };
    const matches = (row) => query.filters.every(([column, value]) => row[column] === value);
    function run() {
      const rows = tables[table];
      if (!rows) return { data: null, error: new Error(`Unknown demo table: ${table}`) };
      if (query.action === "insert") {
        const row = { id: `${table}-${nextId++}`, created_at: new Date().toISOString(), last_scanned_at: null, ...query.payload };
        rows.push(row);
        return { data: [row], error: null };
      }
      if (query.action === "update") {
        rows.filter(matches).forEach((row) => Object.assign(row, query.payload));
        return { data: null, error: null };
      }
      if (query.action === "delete") {
        const removed = new Set(rows.filter(matches).map((row) => row.id));
        tables[table] = rows.filter((row) => !removed.has(row.id));
        if (table === "monitors") tables.threads = tables.threads.filter((thread) => !removed.has(thread.monitor_id));
        return { data: null, error: null };
      }
      let data = rows.filter(matches).map((row) => ({ ...row }));
      if (query.sort) {
        const { column, direction } = query.sort;
        data.sort((a, b) => direction * String(a[column] ?? "").localeCompare(String(b[column] ?? "")));
      }
      if (query.max != null) data = data.slice(0, query.max);
      return { data, error: null };
    }
    const builder = {
      select() { query.action = "select"; return builder; },
      insert(payload) { query.action = "insert"; query.payload = payload; return builder; },
      update(payload) { query.action = "update"; query.payload = payload; return builder; },
      delete() { query.action = "delete"; return builder; },
      eq(column, value) { query.filters.push([column, value]); return builder; },
      order(column, { ascending = true } = {}) { query.sort = { column, direction: ascending ? 1 : -1 }; return builder; },
      limit(count) { query.max = count; return builder; },
      then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject); },
    };
    return builder;
  }

  return {
    from,
    auth: {
      async getSession() { return { data: { session: { user, access_token: "demo" } }, error: null }; },
      async signOut() { return { error: null }; },
      onAuthStateChange() {},
    },
    // Reveals the next queued sample posts, skipping any deleted monitors.
    async demoScan() {
      const found = pending.splice(0, 2).filter((row) => tables.monitors.some((m) => m.id === row.monitor_id));
      tables.threads.push(...found.map(toThread));
      const scannedAt = new Date().toISOString();
      tables.monitors.forEach((monitor) => { monitor.last_scanned_at = scannedAt; });
      return found.length
        ? `Demo scan finished: ${found.length} new sample thread${found.length === 1 ? "" : "s"}.`
        : "Demo scan finished: no new sample threads.";
    },
  };
}

if (typeof module !== "undefined") module.exports = { createDemoClient };
