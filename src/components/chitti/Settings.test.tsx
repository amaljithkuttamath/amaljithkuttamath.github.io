// @vitest-environment jsdom
import { useEffect } from "react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  act,
} from "@testing-library/react";
import Settings from "./Settings";
import { providerProfile } from "../../lib/chitti/workspace/preferences";
import { fetchModels } from "../../lib/chitti/providers";
vi.mock("../../lib/chitti/providers", async (original) => ({
  ...(await original<typeof import("../../lib/chitti/providers")>()),
  fetchModels: vi.fn(),
}));
vi.mock("./ChatGPTConnection", () => ({
  default: ({ onAccount, onModels }: any) => {
    useEffect(() => {
      onAccount("public-account");
      onModels([{ id: "subscription-model", label: "Subscription" }]);
    }, []);
    return <div>Subscription connected</div>;
  },
}));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const value = {
  provider: "openrouter" as const,
  apiKey: "router-test-key",
  model: "router-model",
  sources: ["worldbank"],
  rlm: false,
};
const profiles = {
  openrouter: providerProfile("openrouter", { ...value, remember: true }),
};
const choose = (id: string) =>
  fireEvent.change(screen.getByLabelText("Provider"), {
    target: { value: id },
  });
const field = () => screen.getByLabelText("API key") as HTMLInputElement;
it("preserves separate unsaved API-key drafts and model selections across provider switches", () => {
  const save = vi.fn();
  render(
    <Settings
      value={value}
      profiles={profiles}
      locked={false}
      onSave={save}
      onClose={vi.fn()}
    />,
  );
  fireEvent.change(field(), { target: { value: "updated-router-key" } });
  choose("openai");
  expect(field().value).toBe("");
  fireEvent.change(field(), { target: { value: "openai-test-key" } });
  fireEvent.change(screen.getByLabelText("Model"), {
    target: { value: "custom-openai" },
  });
  choose("chatgpt");
  expect(screen.queryByLabelText("API key")).toBeNull();
  choose("openrouter");
  expect(field().value).toBe("updated-router-key");
  expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe(
    "router-model",
  );
  expect(
    (screen.getByLabelText(/Remember in this tab/) as HTMLInputElement).checked,
  ).toBe(true);
  choose("openai");
  expect(field().value).toBe("openai-test-key");
  expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe(
    "custom-openai",
  );
  expect(
    (screen.getByLabelText(/Remember in this tab/) as HTMLInputElement).checked,
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Use model" }));
  expect(save.mock.calls[0][0]).toMatchObject({
    provider: "openai",
    apiKey: "openai-test-key",
    chatgptAccount: undefined,
  });
  expect(save.mock.calls[0][1].openrouter.apiKey).toBe("updated-router-key");
});
it("cancelling a draft never changes the applied provider profiles", () => {
  const save = vi.fn(),
    close = vi.fn();
  render(
    <Settings
      value={value}
      profiles={profiles}
      locked={false}
      onSave={save}
      onClose={close}
    />,
  );
  fireEvent.change(field(), { target: { value: "discard-this" } });
  choose("anthropic");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(save).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalled();
  expect(profiles.openrouter.apiKey).toBe("router-test-key");
});
it("does not apply a previous provider's late model catalog to the new provider", async () => {
  let resolve!: (value: any) => void;
  vi.mocked(fetchModels).mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  render(
    <Settings
      value={value}
      profiles={profiles}
      locked={false}
      onSave={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
  choose("anthropic");
  await act(async () =>
    resolve([{ id: "stale-router-model", label: "Stale" }]),
  );
  expect(screen.queryByText("Stale")).toBeNull();
  expect(field().value).toBe("");
});
