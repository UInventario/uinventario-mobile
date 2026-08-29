import { OfflineCommand } from '@/pos/contracts';

import { HttpMobileApi } from './mobile-api';

describe('mobile POS API contract', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('uses the cash endpoint and preserves the stable idempotency key', async () => {
    const fetchMock = jest.fn().mockResolvedValue(ok({
      data: { id: 'sale-1', receiptNumber: 'V-1' },
      meta: { apiVersion: '1', idempotentReplay: false },
    }));
    globalThis.fetch = fetchMock;
    const api = new HttpMobileApi('https://api.example.test/api/v1');

    await api.cashSale(
      'token-1',
      { lines: [{ productId: 'product-1', quantity: '1' }], cashReceived: '120.00' },
      'mobile-sale-stable',
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.test/api/v1/pos/sales/cash');
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer token-1');
    expect((init.headers as Headers).get('Idempotency-Key')).toBe('mobile-sale-stable');
    expect(JSON.parse(String(init.body))).toEqual({
      lines: [{ productId: 'product-1', quantity: '1' }],
      cashReceived: '120.00',
      channel: 'MOBILE',
    });
  });

  it('sends only the v1 command envelope and never local outbox metadata', async () => {
    const fetchMock = jest.fn().mockResolvedValue(ok({
      data: { results: [] },
      meta: { apiVersion: '1' },
    }));
    globalThis.fetch = fetchMock;
    const api = new HttpMobileApi('https://api.example.test/api/v1');
    const command = {
      protocolVersion: '1.0',
      commandId: '10000000-0000-4000-8000-000000000099',
      idempotencyKey: 'mobile-sale-command',
      scope: {
        tenantId: 'tenant-1',
        userId: 'user-1',
        deviceId: '10000000-0000-4000-8000-000000000001',
        branchId: 'branch-1',
        cashRegisterId: 'cash-1',
      },
      sequence: 1,
      createdAt: '2026-08-29T08:00:00.000Z',
      valuationMethod: 'MOVING_AVERAGE',
      valuationPolicyVersion: 1,
      kind: 'CASH_SALE',
      payload: {},
      status: 'ERROR',
      attempts: 2,
      retryable: true,
      result: null,
      error: { message: 'offline' },
    } as unknown as OfflineCommand;

    await api.commands('token-1', [command]);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { commands: Record<string, unknown>[] };
    expect(body.commands[0]).toMatchObject({
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      sequence: 1,
      kind: 'CASH_SALE',
    });
    expect(body.commands[0]).not.toHaveProperty('status');
    expect(body.commands[0]).not.toHaveProperty('attempts');
    expect(body.commands[0]).not.toHaveProperty('error');
  });
});

function ok(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}
