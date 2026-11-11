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
import { chartChanges, changeKey } from "../../lib/chitti/chart-insights";
import { ExplanationContext } from "./ChangeExplanation";
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
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
    chartChanges(spec)[0],
  );
  fireEvent.click(screen.getByRole("radio", { name: "From zero" }));
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
    chartChanges(spec)[0],
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
        name: "explain-change",
        context: {
          value: changeKey(chartChanges(spec)[0]),
        },
      }),
    ),
  );
});
it("keeps the zero baseline and original values for a bar chart", async () => {
  const bar = { ...spec, type: "bar" as const };
  render(<Chart spec={bar} />);
  await waitFor(() => expect(setOption).toHaveBeenCalled());
  expect(screen.queryByRole("radio", { name: "Fit values" })).toBeNull();
  expect(setOption.mock.calls[0][0].yAxis.min).toBeUndefined();
  expect(setOption.mock.calls[0][0].series[0].data).toEqual([83.8, 82.3]);
});

it("anchors the explanation to exact plotted values and clears the highlight on close", async () => {
  const change = chartChanges(spec)[0];
  const detail = {
    change,
    analysis: {
      id: "why",
      question: "why",
      phase: "done" as const,
      status: "Done",
      origin: "agent" as const,
      trace: [],
      files: {},
      result: {
        v: 1 as const,
        q: "why",
        answer: "The series records a fall. It does not establish a cause.",
        spec: null,
        rows: [],
        citations: [],
        verification: null,
        ts: "2026-10-24",
      },
    },
    onClose: vi.fn(),
    onRetry: vi.fn(),
    onConnect: vi.fn(),
    onStop: vi.fn(),
  };
  const { rerender } = render(
    <ExplanationContext.Provider value={detail}>
      <Chart spec={spec} onAsk={vi.fn()} />
    </ExplanationContext.Provider>,
  );
  await screen.findByRole("region", { name: /Explanation: Spain/ });
  await waitFor(() => expect(setOption).toHaveBeenCalled());
  const line = setOption.mock.calls.at(-1)![0].series[0];
  expect(line.markLine.data[0]).toEqual([
    { coord: [0, 83.8] },
    { coord: [1, 82.3] },
  ]);
  expect(line.markPoint.data.map((p: any) => p.coord)).toEqual([
    [0, 83.8],
    [1, 82.3],
  ]);
  expect(screen.getByRole("img").getAttribute("aria-label")).toContain(
    "Highlighted Spain, 2019 to 2020",
  );
  fireEvent.click(screen.getByRole("button", { name: "Close explanation" }));
  expect(detail.onClose).toHaveBeenCalled();
  rerender(
    <ExplanationContext.Provider value={null}>
      <Chart spec={spec} />
    </ExplanationContext.Provider>,
  );
  await waitFor(() =>
    expect(setOption.mock.calls.at(-1)![0].series[0].markLine).toBeUndefined(),
  );
  expect(
    screen.queryByRole("region", { name: /Explanation: Spain/ }),
  ).toBeNull();
});
it('uses explicit units, stable colors and declarative annotations across chart types', async () => {
  const annotated: ChartSpec = { ...spec, y_axis: 'Rate', unit: '%', series: [{ ...spec.series[0], id: 'country:ESP' }], annotations: [{ seriesId: 'country:ESP', x: 2020, label: 'Observed endpoint' }] };
  const { rerender } = render(<Chart spec={annotated} />);
  await waitFor(() => expect(setOption).toHaveBeenCalled());
  expect(screen.getByRole('button', { name: /Ask why: Spain/ }).textContent).toContain('pp');
  const first = setOption.mock.calls.at(-1)![0].series[0];
  expect(first.markPoint.data.some((p: any) => p.name === 'Observed endpoint')).toBe(true);
  rerender(<Chart spec={{ ...annotated, type: 'bar' }} />);
  await waitFor(() => expect(setOption.mock.calls.at(-1)![0].series[0].type).toBe('bar'));
  expect(setOption.mock.calls.at(-1)![0].series[0].itemStyle.color).toBe(first.itemStyle.color);
  expect(setOption.mock.calls.at(-1)![0].series[0].markPoint.data[0].name).toBe('Observed endpoint');
});

it("focuses the series on a plain point click when there are several, and still explains a marker", async () => {
  const two: ChartSpec = {
    ...spec,
    series: [
      ...spec.series,
      { name: "Italy", data: [[2019, 83.5], [2020, 82.2]] },
    ],
  };
  const onAsk = vi.fn();
  const onSelect = vi.fn();
  render(<Chart spec={two} onAsk={onAsk} onSelect={onSelect} />);
  await waitFor(() => expect(on).toHaveBeenCalled());
  const click = on.mock.calls.find(([event]) => event === "click")![1];
  click({ componentType: "series", seriesName: "Italy", name: "2020" });
  expect(onAsk).not.toHaveBeenCalled();
  expect(onSelect).toHaveBeenCalledWith("Italy");
  click({ componentType: "markPoint", seriesName: "Italy", data: { changeYear: 2020 } });
  expect(onAsk).toHaveBeenCalledTimes(1);
});
it("lays a named ranking out sideways with room for every bar, and leaves time and grouped bars upright", async () => {
  const { barLayout, buildOption } = await import("../../lib/chitti/ui/chart-option");
  const names = ["Maldives", "China", "Sao Tome and Principe", "Korea, Dem. People's Rep.", "Montenegro", "Latvia", "Cambodia", "Belarus"];
  const ranking: ChartSpec = {
    type: "bar", title: "Falls", x_axis: "Country", y_axis: "%",
    series: [{ name: "Change", data: names.map((n, i) => [n, -80 + i]) }],
    annotations: [{ seriesId: "Change", x: "China", label: "note" }] as any,
  };
  const layout = barLayout(ranking);
  expect(layout.horizontal).toBe(true);
  expect(layout.height).toBe(60 + names.length * 24);
  const option: any = buildOption(ranking);
  expect(option.yAxis.type).toBe("category");
  expect(option.yAxis.data).toEqual(names);
  expect(option.yAxis.inverse).toBe(true);
  expect(option.xAxis.type).toBe("value");
  expect(option.series[0].data).toEqual(names.map((_, i) => -80 + i));
  for (const m of option.series[0].markPoint.data) expect(m.coord).toEqual([-79, 1]);
  const years: ChartSpec = { ...ranking, annotations: undefined, series: [{ name: "GDP", data: names.map((_, i) => [String(2000 + i), i]) }] };
  expect(barLayout(years)).toMatchObject({ horizontal: false });
  expect(barLayout({ ...ranking, series: [{ name: "Change", data: [["A", 1], ["B", 2]] }] }).horizontal).toBe(false);
  expect(barLayout({ ...ranking, type: "grouped-bar" }).horizontal).toBe(false);
  expect((buildOption(years) as any).xAxis.type).toBe("category");
  expect(barLayout(spec)).toEqual({ categories: [], horizontal: false });
});
