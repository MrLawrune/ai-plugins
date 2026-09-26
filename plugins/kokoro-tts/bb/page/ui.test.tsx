import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, test } from "vitest";
import { ChoiceGroup, SaveIndicator, SliderRow } from "./ui.tsx";

const MODES = [
  { value: "quiet", label: "Quiet", hint: "Silent." },
  { value: "brief", label: "Brief", hint: "One short sentence per reply." },
  { value: "full", label: "Full", hint: "Reads the whole reply." },
] as const;

function Modes() {
  const [v, setV] = useState<(typeof MODES)[number]["value"]>("brief");
  return <ChoiceGroup label="Mode" value={v} options={[...MODES]} onChange={setV} />;
}

test("choices are named by their visible label and move with arrow keys", () => {
  render(<Modes />);
  const brief = screen.getByRole("radio", { name: "Brief" });
  expect(brief.getAttribute("aria-checked")).toBe("true");
  expect(brief.tabIndex).toBe(0);
  expect(screen.getByRole("radio", { name: "Full" }).tabIndex).toBe(-1);
  expect(screen.getByRole("radiogroup", { name: "Mode" })).toBeTruthy();
  expect(screen.getByText("One short sentence per reply.")).toBeTruthy();
  fireEvent.keyDown(brief, { key: "ArrowRight" });
  expect(screen.getByRole("radio", { name: "Full" }).getAttribute("aria-checked")).toBe("true");
  expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Full" }));
  fireEvent.keyDown(screen.getByRole("radio", { name: "Full" }), { key: "ArrowRight" });
  expect(screen.getByRole("radio", { name: "Quiet" }).getAttribute("aria-checked")).toBe("true");
});

test("slider thumbs have a name and a spoken value", () => {
  render(<SliderRow id="speed" label="Speed" value={1.2} min={0.5} max={2} step={0.05} format={(v) => `${v.toFixed(2)}×`} onChange={() => {}} />);
  const thumb = screen.getByRole("slider", { name: "Speed" });
  expect(thumb.getAttribute("aria-valuetext")).toBe("1.20×");
});

test("the save indicator shows failures with a retry", () => {
  let retried = false;
  render(<SaveIndicator state={{ kind: "error", message: "server busy", retry: () => { retried = true; } }} />);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(retried).toBe(true);
  expect(screen.getByText(/Not saved/)).toBeTruthy();
});
