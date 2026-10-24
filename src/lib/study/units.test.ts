import { it, expect } from "vitest";
import { byteUnits, tokenUnits } from "./units";
it("uses actual UTF-8 bytes, including multibyte characters", () => {
  expect(byteUnits("A")[0]).toMatchObject({
    id: 65,
    bits: "01000001",
    label: "A",
  });
  expect(byteUnits("👋").map((u) => u.id)).toEqual([240, 159, 145, 139]);
  expect(byteUnits("👋").map((u) => u.group)).toEqual([0, 0, 0, 0]);
  expect(byteUnits("")).toEqual([]);
});
it("displays real vocabulary IDs without treating them as confidence", () => {
  const units = tokenUnits([77, 128000], (id) => (id === 77 ? " test" : "!"));
  expect(units[0].label).toBe("·test");
  expect(tokenUnits([233], () => "�")[0].label).toBe("[byte]");
  expect(units[1].bits).toBe((128000).toString(2).padStart(18, "0"));
});
