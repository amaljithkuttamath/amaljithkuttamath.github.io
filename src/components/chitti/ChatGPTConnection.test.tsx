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
      await screen.findByRole("link", { name: /Continue with ChatGPT/ })
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
