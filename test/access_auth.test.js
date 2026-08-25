import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { requiredAccessAudience } from '../cloudflare/access-auth.js';

describe('Cloudflare Access audience isolation', () => {
  const env = {
    ACCESS_AUD: 'dashboard-audience',
    MCP_ACCESS_AUD: 'mcp-audience',
  };

  test('human dashboard sessions retain the dashboard audience', () => {
    assert.equal(requiredAccessAudience({ email: 'owner@example.com' }, env), 'dashboard-audience');
    assert.equal(
      requiredAccessAudience({ email: 'owner@example.com' }, env, { allowServiceToken: true }),
      'dashboard-audience',
    );
  });

  test('service credentials use the path-scoped MCP audience only on machine-enabled routes', () => {
    const payload = { common_name: 'client-id.access' };
    assert.equal(requiredAccessAudience(payload, env), 'dashboard-audience');
    assert.equal(
      requiredAccessAudience(payload, env, { allowServiceToken: true }),
      'mcp-audience',
    );
  });
});
