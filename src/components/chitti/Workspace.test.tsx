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
vi.mock("./Chart", () => ({ default: () => <div>Chart rendered</div> }));
vi.mock("../../lib/chitti/fastpath", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/chitti/fastpath")>()),
  runFastPath: vi.fn(),
}));
import Workspace from "./Workspace";
import { runFastPath } from "../../lib/chitti/fastpath";
import { DEMOS } from "../../lib/chitti/demos";
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.clearAllMocks();
});
it("keeps the previous artifact visible while a new AG-UI run prepares its replacement", async () => {
  let resolve!: (value: Awaited<ReturnType<typeof runFastPath>>) => void;
  vi.mocked(runFastPath).mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  render(<Workspace />);
  const previous = DEMOS[0];
  await screen.findByRole("heading", { name: previous.question });
  const question = "Chart life expectancy in Japan since 1960";
  fireEvent.change(screen.getByLabelText("Ask a data question"), {
    target: { value: question },
  });
  fireEvent.click(screen.getByRole("button", { name: "Analyze" }));
  await screen.findByRole("button", { name: "Stop" });
  expect(screen.getByRole("heading", { name: previous.question })).toBeTruthy();
  await waitFor(() => expect(runFastPath).toHaveBeenCalled());
  await act(async () =>
    resolve({
      spec: previous.state.spec!,
      rows: previous.state.rows,
      citations: previous.state.citations,
      summary: "Result from the test source",
      trace: [],
    }),
  );
  await screen.findByRole("heading", { name: question });
  expect(screen.queryByRole("heading", { name: previous.question })).toBeNull();
  expect(screen.getByRole("button", { name: "View result" })).toBeTruthy();
  expect(screen.getByText("Result from the test source")).toBeTruthy();
});
