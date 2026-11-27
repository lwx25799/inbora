import { expect, test, vi } from "vitest";
import { invokeReadonlyBusinessTool } from "../../src/ai/readonly-business-tools.js";
import type { AccountAiFeatures } from "../../src/contracts/ai-runtime.js";

function baseFeatures(overrides: Partial<AccountAiFeatures> = {}): AccountAiFeatures {
  return {
    visionEnabled: false,
    mediaReplyEnabled: false,
    enabledBusinessTools: ["query_order_status", "query_logistics_trace"],
    toolEndpoints: {
      query_order_status: "https://erp.example.com/api/orders",
      query_logistics_trace: "https://erp.example.com/api/logistics",
    },
    syncCustomerAvatars: false,
    ...overrides,
  };
}

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

test("rejects non-whitelisted tools, write methods, disabled tools, and unconfigured endpoints", async () => {
  await expect(
    invokeReadonlyBusinessTool({
      accountFeatures: baseFeatures(),
      toolId: "delete_order",
      params: { orderId: "123" },
      lookup: publicLookup,
    }),
  ).rejects.toThrow("BUSINESS_TOOL_FORBIDDEN");

  await expect(
    invokeReadonlyBusinessTool({
      accountFeatures: baseFeatures(),
      toolId: "query_order_status",
      method: "POST",
      params: { orderId: "123" },
      lookup: publicLookup,
    }),
  ).rejects.toThrow("BUSINESS_TOOL_FORBIDDEN");

  await expect(
    invokeReadonlyBusinessTool({
      accountFeatures: baseFeatures(),
      toolId: "query_inventory_stock",
      params: { sku: "SKU-1" },
      lookup: publicLookup,
    }),
  ).rejects.toThrow("BUSINESS_TOOL_FORBIDDEN");

  await expect(
    invokeReadonlyBusinessTool({
      accountFeatures: baseFeatures({
        enabledBusinessTools: ["query_inventory_stock"],
        toolEndpoints: {},
      }),
      toolId: "query_inventory_stock",
      params: { sku: "SKU-1" },
      lookup: publicLookup,
    }),
  ).rejects.toThrow("BUSINESS_TOOL_NOT_CONFIGURED");
});

test("enforces SSRF URL & DNS checks, redirect rejection, 32 KiB limit, and maxRetries=0", async () => {
  await expect(
    invokeReadonlyBusinessTool({
      accountFeatures: baseFeatures({
        toolEndpoints: { query_order_status: "http://127.0.0.1:8080/orders" },
      }),
      toolId: "query_order_status",
      params: { orderId: "123" },
      lookup: publicLookup,
    }),
  ).rejects.toThrow("BUSINESS_TOOL_FORBIDDEN");

  await expect(
    invokeReadonlyBusinessTool({
      accountFeatures: baseFeatures(),
      toolId: "query_order_status",
      params: { orderId: "123" },
      lookup: async () => [{ address: "10.0.0.8", family: 4 }],
    }),
  ).rejects.toThrow("BUSINESS_TOOL_FORBIDDEN");

  const redirectTransport = vi.fn<typeof fetch>(async () =>
    new Response(null, { status: 302, headers: { location: "https://evil.example.com" } }),
  );
  await expect(
    invokeReadonlyBusinessTool({
      accountFeatures: baseFeatures(),
      toolId: "query_order_status",
      params: { orderId: "123" },
      lookup: publicLookup,
      transport: redirectTransport,
    }),
  ).rejects.toThrow("BUSINESS_TOOL_FAILED");
  expect(redirectTransport).toHaveBeenCalledTimes(1);

  const errorTransport = vi.fn<typeof fetch>(async () => new Response("error", { status: 503 }));
  await expect(
    invokeReadonlyBusinessTool({
      accountFeatures: baseFeatures(),
      toolId: "query_order_status",
      params: { orderId: "123" },
      lookup: publicLookup,
      transport: errorTransport,
    }),
  ).rejects.toThrow("BUSINESS_TOOL_FAILED");
  expect(errorTransport).toHaveBeenCalledTimes(1);

  const oversizedTransport = vi.fn<typeof fetch>(async () =>
    new Response(JSON.stringify({ blob: "x".repeat(33 * 1024) }), { status: 200 }),
  );
  await expect(
    invokeReadonlyBusinessTool({
      accountFeatures: baseFeatures(),
      toolId: "query_order_status",
      params: { orderId: "123" },
      lookup: publicLookup,
      transport: oversizedTransport,
    }),
  ).rejects.toThrow("BUSINESS_TOOL_FAILED");

  // DNS lookup respects caller abort / deadline and swallows late rejection cleanly
  const stalledLookup = () => new Promise<{ address: string; family: number }[]>((_, reject) => {
    setTimeout(() => reject(new Error("late dns failure")), 15);
  });
  const abort = new AbortController();
  abort.abort();
  await expect(
    invokeReadonlyBusinessTool({
      accountFeatures: baseFeatures(),
      toolId: "query_order_status",
      params: { orderId: "123" },
      lookup: stalledLookup,
      signal: abort.signal,
    }),
  ).rejects.toThrow("BUSINESS_TOOL_FAILED");
  await new Promise(resolve => setTimeout(resolve, 30));

  // 204 / 205 / 304 bodyless statuses fail cleanly without constructing invalid Response
  for (const status of [204, 205, 304]) {
    const emptyTransport = vi.fn<typeof fetch>(async () => ({
      status,
      ok: status >= 200 && status < 300,
      redirected: false,
      type: "basic",
      body: null,
    } as Response));
    await expect(
      invokeReadonlyBusinessTool({
        accountFeatures: baseFeatures(),
        toolId: "query_order_status",
        params: { orderId: "123" },
        lookup: publicLookup,
        transport: emptyTransport,
      }),
    ).rejects.toThrow("BUSINESS_TOOL_FAILED");
  }
});

test("executes GET-only readonly tool and redacts sensitive fields", async () => {
  const transport = vi.fn<typeof fetch>(async () =>
    Response.json({
      orderId: "ORD-1001",
      status: "SHIPPED",
      phone: "13800138000",
      token: "secret-token",
      note: "联系 13912345678 或 user@example.com",
      address: "北京市朝阳区1号",
    }),
  );
  const result = await invokeReadonlyBusinessTool({
    accountFeatures: baseFeatures(),
    toolId: "query_order_status",
    params: { orderId: "ORD-1001" },
    lookup: publicLookup,
    transport,
  });

  expect(transport).toHaveBeenCalledTimes(1);
  const [url, init] = transport.mock.calls[0]!;
  expect(String(url)).toBe("https://erp.example.com/api/orders?orderId=ORD-1001");
  expect(init?.method).toBe("GET");
  expect(init?.redirect).toBe("error");
  expect(result).toEqual({
    toolId: "query_order_status",
    status: 200,
    redacted: true,
    data: {
      orderId: "ORD-1001",
      status: "SHIPPED",
      phone: "[REDACTED]",
      token: "[REDACTED]",
      note: "联系 [REDACTED_PHONE] 或 [REDACTED_EMAIL]",
      address: "[REDACTED]",
    },
  });
});
