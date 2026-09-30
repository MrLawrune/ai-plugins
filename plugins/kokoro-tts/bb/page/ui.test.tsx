import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { expect, test } from "vitest";
import { ChoiceGroup, SaveIndicator, SliderRow, StopSlider } from "./ui.tsx";

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

test("a stop slider names its stop, shows its hint, and reports a move once", () => {
  const moves: string[] = [];
  render(<StopSlider label="Mode" value="brief" options={[...MODES]} onChange={(v) => { moves.push(v); }} />);
  const thumb = screen.getByRole("slider", { name: "Mode" });
  expect(thumb.getAttribute("aria-valuetext")).toBe("Brief");
  expect(screen.getByText("One short sentence per reply.")).toBeTruthy();
  fireEvent.keyDown(thumb, { key: "ArrowRight" });
  expect(moves).toEqual(["full"]);
});

test("a stop slider holds a move until its save settles, then shows the saved value", async () => {
  let settle!: () => void;
  render(<StopSlider label="Mode" value="brief" inherited options={[...MODES]}
    onChange={() => new Promise<void>((r) => { settle = r; })} />);
  const thumb = screen.getByRole("slider", { name: "Mode" });
  expect(thumb.getAttribute("aria-valuetext")).toBe("Brief, default");
  fireEvent.keyDown(thumb, { key: "ArrowLeft" });
  expect(thumb.getAttribute("aria-valuetext")).toBe("Quiet");
  settle();
  await waitFor(() => expect(thumb.getAttribute("aria-valuetext")).toBe("Brief, default"));
});

test("the save indicator shows failures with a retry", () => {
  let retried = false;
  render(<SaveIndicator state={{ kind: "error", message: "server busy", retry: () => { retried = true; } }} />);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(retried).toBe(true);
  expect(screen.getByText(/Not saved/)).toBeTruthy();
});
