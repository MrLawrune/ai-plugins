import { test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
test("vitest + jsdom render", () => {
  render(<p>ok</p>);
  expect(screen.getByText("ok")).toBeTruthy();
});
