export function createGameControl(config, fetchImpl = fetch, sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))) {
  async function request(path, options = {}) {
    if (!config.controlApiUrl || !config.controlApiToken) throw new Error('Game control API is not configured');
    const response = await fetchImpl(new URL(path, config.controlApiUrl), {
      ...options,
      headers: {
        Authorization: `Bearer ${config.controlApiToken}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Game control failed with ${response.status}`);
    return body;
  }

  async function waitForOperation(id) {
    const deadline = Date.now() + 15 * 60 * 1000;
    while (Date.now() < deadline) {
      await sleep(2_000);
      const operation = await request(`/api/admin/operations/${encodeURIComponent(id)}`);
      if (operation.state === 'complete') return operation.result;
      if (operation.state === 'failed') throw new Error(operation.error || 'Game switch failed');
    }
    throw new Error('Game switch did not complete within 15 minutes');
  }

  return {
    status: () => request('/api/admin/status'),
    switchGame: async (target) => {
      const operation = await request('/api/admin/switch', { method: 'POST', body: JSON.stringify({ target }) });
      return waitForOperation(operation.id);
    },
  };
}
