import { expect, it } from "vitest";
import { mdToHtml } from "./dom";
it("renders institutional source links without exposing markdown syntax", () => {
  expect(mdToHtml("See [**World Bank**](https://data.worldbank.org/indicator/SH.DYN.MORT?a=1&b=2)."))
    .toContain('<a href="https://data.worldbank.org/indicator/SH.DYN.MORT?a=1&amp;b=2" target="_blank" rel="noopener noreferrer"><strong>World Bank</strong></a>');
});
it("cannot create executable links or inject attributes and markup", () => {
  expect(mdToHtml('[bad](javascript:alert(1))')).not.toContain('<a');
  expect(mdToHtml('[bad](data:text/html,test)')).not.toContain('<a');
  const html = mdToHtml('[<img src=x onerror=alert(1)>](https://example.com/"onmouseover="evil)');
  expect(html).not.toContain('<img');
  expect(html).toContain('&quot;onmouseover=&quot;');
  expect(html).not.toContain('href="https://example.com/"');
});
it("leaves underscores and emphasis markers inside source URLs intact", () => {
  expect(mdToHtml('[source](https://example.com/a*b*c_d)')).toContain('href="https://example.com/a*b*c_d"');
});
