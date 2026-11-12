import { expect, test } from "@playwright/test";

test("the 200-node study keeps names legible and every entity selectable", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/previews/map/");
  const map = page.getByRole("region", { name: "Interactive 3D story map" });
  const picker = page.getByRole("combobox", { name: "Inspect entity" });
  const labels = map.locator(".map-node-label");
  await expect(labels).toHaveCount(200);
  await expect(picker.getByRole("option")).toHaveCount(201);
  await expect(map.getByLabel("Map style")).toHaveValue("circles");
  const visible = map.locator(".map-node-label:visible");
  await expect.poll(() => visible.count()).toBeGreaterThan(0);
  expect(await visible.count()).toBeLessThan(200);
  const boxes = await visible.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()));
  for (const [index, box] of boxes.entries()) {
    for (const other of boxes.slice(0, index)) {
      expect(box.right <= other.left || other.right <= box.left || box.bottom <= other.top || other.bottom <= box.top).toBe(true);
    }
  }

  const fogLevels = () => labels.evaluateAll(elements => elements.map(element =>
    Number((element as HTMLElement).style.getPropertyValue("--depth-opacity"))));
  const beforeOrbit = await fogLevels();
  expect(Math.max(...beforeOrbit)).toBe(1);
  expect(Math.min(...beforeOrbit)).toBeLessThan(0.8);
  const canvas = map.getByRole("img", { name: "3D story relationship map" });
  for (let i = 0; i < 4; i++) await canvas.press("ArrowRight");
  await expect.poll(async () => (await fogLevels()).some((level, i) => Math.abs(level - beforeOrbit[i]) > 0.15)).toBe(true);
  await map.getByRole("button", { name: "Reset map view" }).click();

  const hiddenName = await map.locator(".map-node-label[hidden]").first().textContent();
  await picker.selectOption({ label: hiddenName! });
  const selected = map.getByRole("button", { name: `Inspect ${hiddenName}`, exact: true });
  await expect(selected).toBeVisible();
  await expect(selected).toHaveAttribute("aria-pressed", "true");
  await expect(selected).toHaveCSS("opacity", "1");
  await map.getByLabel("Map style").selectOption("bookplate");
  await expect(selected).toHaveAttribute("aria-pressed", "true");
  await picker.selectOption("");
  await expect(labels.locator("visible=true").first()).toBeVisible();
  await expect(map.locator('.map-node-label[aria-pressed="true"]')).toHaveCount(0);
});
