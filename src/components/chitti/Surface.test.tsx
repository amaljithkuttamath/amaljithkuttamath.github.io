// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import Surface from "./Surface";
import {
  questionSurface,
  resultSurface,
} from "../../lib/chitti/workspace/model";
import { DEMOS } from "../../lib/chitti/demos";
vi.mock("./Chart", () => ({ default: () => <div>Chart rendered</div> }));
afterEach(cleanup);
describe("A2UI surfaces", () => {
  it("renders catalog controls and returns an A2UI action without executing generated code", async () => {
    const onAction = vi.fn();
    render(
      <Surface
        operations={questionSurface({
          id: "q1",
          question: "Which measure?",
          options: ["Total", "Per person"],
        })}
        onAction={onAction}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Per person" }));
    await vi.waitFor(() => expect(onAction).toHaveBeenCalled());
    expect(onAction.mock.calls[0][0]).toMatchObject({
      name: "answer",
      context: { requestId: "q1", value: "Per person" },
    });
    expect(
      screen.getByRole("button", { name: "Total" }).hasAttribute("disabled"),
    ).toBe(true);
  });
  it("renders source provenance and filters real recorded evidence rows", async () => {
    render(<Surface operations={resultSurface(DEMOS[0].state)} />);
    fireEvent.click(await screen.findByRole("tab", { name: /Sources/ }));
    expect(screen.getByText("Exact data request ↗")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Data/ }));
    fireEvent.change(screen.getByLabelText("Filter rows"), {
      target: { value: "zz-no-country" },
    });
    expect(screen.getByText("No matching rows.")).toBeTruthy();
  });
  it("rejects an unregistered catalog", async () => {
    render(
      <Surface
        operations={[
          {
            version: "v0.9",
            createSurface: {
              surfaceId: "x",
              catalogId: "https://untrusted.invalid/catalog",
            },
          },
        ]}
      />,
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});
