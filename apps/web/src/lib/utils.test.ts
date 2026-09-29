import { describe, expect, it } from "vitest";
import { money, compact, percent, shortDate, escapeHtml } from "./utils";
describe("exact decimal display", () => {
  it("preserves API decimal precision beyond binary float and rounds half up", () => {
    expect(money("9007199254740993.125")).toBe("9,007,199,254,740,993.13");
    expect(money("100.005")).toBe("100.01");
    expect(money("-100.005")).toBe("-100.01");
    expect(money("19.99995", 4)).toBe("20.0000");
    expect(money(null)).toBe("—");
    expect(money("NaN")).toBe("—");
    expect(money("-0.0000")).toBe("0.00");
  });
  it("scales decimals for compact amounts and ratios without changing source", () => {
    expect(compact("123456.789")).toBe("12.35万");
    expect(compact("-123456.789")).toBe("-12.35万");
    expect(percent("0.19995")).toBe("20.0%");
    expect(percent(null)).toBe("—");
    expect(percent("-0.029")).toBe("-2.9%");
  });
});
describe("Shanghai business dates and tooltip text", () => {
  it("converts timezone-bearing event timestamps into the business date", () => {
    expect(shortDate("2026-04-01T16:00:00Z")).toBe("2026-04-02");
    expect(shortDate("2026-04-02")).toBe("2026-04-02");
    expect(shortDate("2026-04-01T23:59:59+08:00")).toBe("2026-04-01");
    expect(shortDate("invalid")).toBe("—");
  });
  it("treats imported names as text in custom HTML tooltips", () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    );
  });
});
