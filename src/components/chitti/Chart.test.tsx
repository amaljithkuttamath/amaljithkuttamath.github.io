// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ChartSpec } from "../../lib/chitti/core";
const { setOption, on, dispose } = vi.hoisted(() => ({
  setOption: vi.fn(),
  on: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock("./chart-runtime", () => ({
  init: () => ({ setOption, on, dispose, resize: vi.fn() }),
}));
import Chart from "./Chart";
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);
const spec: ChartSpec = {
  type: "line",
  title: "Life expectancy",
  x_axis: "Year",
  y_axis: "years",
  series: [
    {
      name: "Spain",
      data: [
        [2019, 83.8],
        [2020, 82.3],
      ],
    },
  ],
};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("exposes a fitted axis, actual change and keyboard-accessible explanation action", async () => {
  const onAsk = vi.fn();
  render(<Chart spec={spec} onAsk={onAsk} />);
  await waitFor(() => expect(setOption).toHaveBeenCalled());
  expect(setOption.mock.calls[0][0].yAxis.min).toBeGreaterThan(80);
  fireEvent.click(screen.getByRole("button", { name: /Ask why: Spain/ }));
  expect(onAsk).toHaveBeenCalledWith(
    "Why did Spain change from 83.8 to 82.3 between 2019 and 2020?",
  );
  fireEvent.click(screen.getByRole("button", { name: "From zero" }));
  await waitFor(() =>
    expect(setOption.mock.calls.at(-1)![0].yAxis.min).toBeUndefined(),
  );
  expect(screen.getByText("Axis includes zero")).toBeTruthy();
});
it("routes a plotted marker click to the same exact change question", async () => {
  const onAsk = vi.fn();
  render(<Chart spec={spec} onAsk={onAsk} />);
  await waitFor(() => expect(on).toHaveBeenCalled());
  const click = on.mock.calls.find(([event]) => event === "click")![1];
  click({
    componentType: "markPoint",
    seriesName: "Spain",
    data: { changeYear: 2020 },
  });
  expect(onAsk).toHaveBeenCalledWith(
    expect.stringContaining("83.8 to 82.3 between 2019 and 2020"),
  );
});
it("does not offer active agent actions during a run", async () => {
  render(<Chart spec={spec} />);
  expect(
    screen
      .getByRole("button", { name: /Ask why: Spain/ })
      .hasAttribute("disabled"),
  ).toBe(true);
});
it("sends a clicked change through the actual A2UI result surface", async () => {
  const { default: Surface } = await import("./Surface");
  const { resultSurface } = await import("../../lib/chitti/workspace/model");
  const onAction = vi.fn();
  render(
    <Surface
      operations={resultSurface({
        v: 1,
        q: "Compare life expectancy",
        answer: "",
        spec,
        rows: [],
        citations: [],
        verification: null,
        ts: "2026-10-24",
      })}
      onAction={onAction}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: /Ask why: Spain/ }),
  );
  await waitFor(() =>
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "ask-view",
        context: {
          value:
            "Why did Spain change from 83.8 to 82.3 between 2019 and 2020?",
        },
      }),
    ),
  );
});
it("keeps the zero baseline and original values for a bar chart", async () => {
  const bar = { ...spec, type: "bar" as const };
  render(<Chart spec={bar} />);
  await waitFor(() => expect(setOption).toHaveBeenCalled());
  expect(screen.queryByRole("button", { name: "Fit values" })).toBeNull();
  expect(setOption.mock.calls[0][0].yAxis.min).toBeUndefined();
  expect(setOption.mock.calls[0][0].series[0].data).toEqual([83.8, 82.3]);
});
