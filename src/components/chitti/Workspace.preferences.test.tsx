// @vitest-environment jsdom
import { useEffect } from "react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import Workspace from "./Workspace";
import { PREFERENCES_KEY } from "../../lib/chitti/workspace/preferences";
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
  sessionStorage.clear();
});
const open = () =>
  fireEvent.click(screen.getByRole("button", { name: "Model settings" }));
const choose = (id: string) =>
  fireEvent.change(
    screen.getByRole("combobox", { name: "Provider", exact: true }),
    { target: { value: id } },
  );
const apply = () =>
  fireEvent.click(screen.getByRole("button", { name: "Use model" }));
const key = () => screen.getByLabelText("API key") as HTMLInputElement;
function enterRouter(remember: boolean) {
  open();
  choose("openrouter");
  fireEvent.change(key(), { target: { value: "synthetic-router-key" } });
  fireEvent.change(screen.getByLabelText("Model"), {
    target: { value: "router-model" },
  });
  if (remember) fireEvent.click(screen.getByLabelText(/Remember in this tab/));
  apply();
}
it("keeps a remembered OpenRouter key/model across ChatGPT selection and a full workspace reload", () => {
  const view = render(<Workspace />);
  enterRouter(true);
  open();
  choose("chatgpt");
  apply();
  view.unmount();
  render(<Workspace />);
  open();
  choose("openrouter");
  expect(key().value).toBe("synthetic-router-key");
  expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe(
    "router-model",
  );
  expect(
    (screen.getByLabelText(/Remember in this tab/) as HTMLInputElement).checked,
  ).toBe(true);
  apply();
  open();
  choose("openai");
  expect(key().value).toBe("");
});
it("keeps an unremembered key while switching within the page, but never saves it across reload", () => {
  const view = render(<Workspace />);
  enterRouter(false);
  open();
  choose("chatgpt");
  apply();
  expect(sessionStorage.getItem(PREFERENCES_KEY)).not.toContain(
    "synthetic-router-key",
  );
  open();
  choose("openrouter");
  expect(key().value).toBe("synthetic-router-key");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  view.unmount();
  render(<Workspace />);
  open();
  choose("openrouter");
  expect(key().value).toBe("");
});
