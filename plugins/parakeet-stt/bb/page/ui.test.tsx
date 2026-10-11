import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, test } from "vitest";
import { ChoiceGroup, SaveIndicator, SliderRow, StatusDot } from "./ui.tsx";

const MODES = [
  { value: "continuous", label: "Continuous", hint: "Keeps listening." },
  { value: "oneshot", label: "One-shot", hint: "One phrase, then stop." },
] as const;

function Modes() {
  const [v, setV] = useState<(typeof MODES)[number]["value"]>("continuous");
  return <ChoiceGroup label="Mode" value={v} options={[...MODES]} onChange={setV} />;
}

test("choices are named by their visible label and move with arrow keys", () => {
  render(<Modes />);
  const first = screen.getByRole("radio", { name: "Continuous" });
  expect(first.getAttribute("aria-checked")).toBe("true");
  expect(first.tabIndex).toBe(0);
  expect(screen.getByRole("radio", { name: "One-shot" }).tabIndex).toBe(-1);
  expect(screen.getByRole("radiogroup", { name: "Mode" })).toBeTruthy();
  expect(screen.getByText("Keeps listening.")).toBeTruthy();
  fireEvent.keyDown(first, { key: "ArrowRight" });
  expect(screen.getByRole("radio", { name: "One-shot" }).getAttribute("aria-checked")).toBe("true");
  expect(document.activeElement).toBe(screen.getByRole("radio", { name: "One-shot" }));
  fireEvent.keyDown(screen.getByRole("radio", { name: "One-shot" }), { key: "ArrowRight" });
  expect(screen.getByRole("radio", { name: "Continuous" }).getAttribute("aria-checked")).toBe("true");
});

test("slider thumbs have a name and a spoken value", () => {
  render(<SliderRow id="pause" label="Pause" value={700} min={300} max={1500} step={50} format={(v) => `${v} ms`} onChange={() => {}} />);
  expect(screen.getByRole("slider", { name: "Pause" }).getAttribute("aria-valuetext")).toBe("700 ms");
});

test("the save indicator shows failures with a retry", () => {
  let retried = false;
  render(<SaveIndicator state={{ kind: "error", message: "server busy", retry: () => { retried = true; } }} />);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(retried).toBe(true);
  expect(screen.getByText(/Not saved/)).toBeTruthy();
});

test("the status dot is decorative", () => {
  const { container } = render(<StatusDot tone="ok" />);
  expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
});
