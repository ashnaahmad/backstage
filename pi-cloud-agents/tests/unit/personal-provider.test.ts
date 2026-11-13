import { type Credential, type CredentialStore, createModels } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { expect, it } from "vitest";

it("the pinned Pi supports openai/gpt-6.1-sol and direct ChatGPT OAuth without another provider adapter", async () => {
  const credential: Credential = {
    type: "oauth",
    access: "fake-access",
    refresh: "fake-refresh",
    expires: Date.now() + 3600000,
    clientId: "fake-issued-client",
  };
  const credentials: CredentialStore = {
    read: async () => credential,
    list: async () => [{ providerId: "openai", type: "oauth" }],
    modify: async (_provider, fn) => fn(credential),
    delete: async () => {},
  };
  const models = createModels({ credentials });
  models.setProvider(openaiProvider());
  const model = models.getModel("openai", "gpt-6.1-sol");
  expect(model).toBeDefined();
  const resolved = await models.getAuth(model!);
  expect(resolved?.auth.apiKey).toBe("fake-access");
});
