// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  act,
} from "@testing-library/react";
import ChatGPTConnection from "./ChatGPTConnection";
import { companion, chatGPTModels } from "../../lib/chitti/chatgpt";
vi.mock("../../lib/chitti/chatgpt", () => ({
  companion: vi.fn(),
  chatGPTModels: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it("explains how to start the companion without asking for an API key", async () => {
  vi.mocked(companion).mockRejectedValue(new Error("Start the companion."));
  render(<ChatGPTConnection onAccount={vi.fn()} onModels={vi.fn()} />);
  await screen.findByText("Start the companion.");
  expect(screen.getByText(/npm run chitti:connect/)).toBeTruthy();
  expect(screen.queryByLabelText("API key")).toBeNull();
});
it("selects a connected account and its catalog without moving credentials into the UI", async () => {
  vi.mocked(companion).mockResolvedValue({
    accounts: [{ id: "issued", label: "Account · issued", connected: true }],
  });
  vi.mocked(chatGPTModels).mockResolvedValue([
    { id: "available", label: "Available model" },
  ]);
  const account = vi.fn(),
    models = vi.fn();
  render(<ChatGPTConnection onAccount={account} onModels={models} />);
  await waitFor(() => expect(account).toHaveBeenCalledWith("issued"));
  expect(models).toHaveBeenCalledWith([
    { id: "available", label: "Available model" },
  ]);
});
it("offers the official sign-in link and allows restarting an expired attempt", async () => {
  vi.mocked(companion)
    .mockResolvedValueOnce({ accounts: [] })
    .mockResolvedValue({
      url: "https://auth.openai.com/api/accounts/authorize?state=test",
    });
  render(<ChatGPTConnection onAccount={vi.fn()} onModels={vi.fn()} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Continue with ChatGPT" }),
  );
  expect(
    (
      await screen.findByRole("link", { name: /Open ChatGPT sign-in/ })
    ).getAttribute("href"),
  ).toContain("https://auth.openai.com/");
  expect(screen.getByRole("button", { name: "Restart sign-in" })).toBeTruthy();
});
it("does not replace the provider model after the component unmounts", async () => {
  let resolve: (value: any) => void = () => {};
  vi.mocked(companion).mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const models = vi.fn(),
    account = vi.fn();
  const view = render(
    <ChatGPTConnection onAccount={account} onModels={models} />,
  );
  view.unmount();
  await act(async () =>
    resolve({
      accounts: [{ id: "issued", label: "Account", connected: true }],
    }),
  );
  expect(account).not.toHaveBeenCalled();
  expect(models).not.toHaveBeenCalled();
});
it("detects completed browser sign-in and loads the new account without a manual check", async () => {
  vi.mocked(companion).mockImplementation(async (path) =>
    path === "auth/start"
      ? {
          url: "https://auth.openai.com/api/accounts/authorize?state=test",
          opened: true,
        }
      : { accounts: [] },
  );
  const onAccount = vi.fn(),
    onModels = vi.fn();
  render(<ChatGPTConnection onAccount={onAccount} onModels={onModels} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Continue with ChatGPT" }),
  );
  await screen.findByText(/Finish sign-in in your browser/);
  vi.mocked(companion).mockResolvedValue({
    authorizing: false,
    lastConnected: "new-account",
    accounts: [{ id: "new-account", label: "Signed in", connected: true }],
  });
  vi.mocked(chatGPTModels).mockResolvedValue([
    { id: "available", label: "Available" },
  ]);
  await waitFor(() => expect(onAccount).toHaveBeenCalledWith("new-account"), {
    timeout: 3000,
  });
  expect(onModels).toHaveBeenCalledWith([
    { id: "available", label: "Available" },
  ]);
  expect(
    screen.queryByRole("link", { name: /Open ChatGPT sign-in/ }),
  ).toBeNull();
});
it("keeps catalog failures visible for an already connected account", async () => {
  vi.mocked(companion).mockResolvedValue({
    accounts: [{ id: "issued", label: "Signed in", connected: true }],
  });
  vi.mocked(chatGPTModels).mockRejectedValue(
    new Error("Model catalog unavailable"),
  );
  render(
    <ChatGPTConnection
      account="issued"
      onAccount={vi.fn()}
      onModels={vi.fn()}
    />,
  );
  await screen.findByText("Model catalog unavailable");
  expect(screen.getByRole("status").textContent).toBe(
    "Model catalog unavailable",
  );
});
